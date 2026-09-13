/**
 * The web dashboard: the same four views as the TUI, over SSE, for demos and for whoever is not at the
 * terminal. Binds to 127.0.0.1 by default and warns when exposed: it shows the whole fleet's state.
 * It is a different server from the HTTP transport, which MUST listen on 0.0.0.0 because remi calls it.
 */
import type { AddressInfo } from 'node:net'
import { type ServerType, serve } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { EventBus, EventName, KitEvents } from '../core/events'
import type { FleetManager } from '../core/fleet-manager'
import { botRows, createModel, reduce, type TuiModel } from '../tui/model'
import { PAGE_HTML } from './page'

const SNAPSHOT_EVERY_MS = 2_000

export function createWebApp(deps: { bus: EventBus; manager: FleetManager; demo?: boolean }): Hono & { close(): void } {
    let model: TuiModel = createModel()
    // Kept so `close()` can drop it: an app that outlives its server and keeps folding every bus
    // event into a model nobody reads is a leak that grows for as long as `efk start` runs.
    const offBus = deps.bus.onAny((name, payload) => {
        model = reduce(model, name, payload as never, Date.now())
    })
    const snapshot = () => {
        const now = Date.now()
        return {
            namespace: deps.manager.config()?.namespace ?? null,
            demo: deps.demo === true,
            bots: botRows(deps.manager, model, now),
            commands: model.commands.slice(0, 100),
            events: model.events.slice(0, 100),
            log: model.log.slice(0, 200),
        }
    }

    const app = new Hono() as Hono & { close(): void }
    app.close = offBus
    app.get('/', (c) => c.html(PAGE_HTML))
    app.get('/api/snapshot', (c) => {
        const { namespace: _ns, demo: _demo, ...rest } = snapshot()
        return c.json(rest)
    })
    app.get('/events', (c) =>
        streamSSE(c, async (stream) => {
            let id = 0
            const off = deps.bus.onAny((name: EventName, payload: KitEvents[EventName]) => {
                void stream.writeSSE({ event: name, data: JSON.stringify(payload), id: String(id++) })
            })
            const timer = setInterval(() => {
                void stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot()), id: String(id++) })
            }, SNAPSHOT_EVERY_MS)
            stream.onAbort(() => {
                off()
                clearInterval(timer)
            })
            await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot()), id: String(id++) })
            await new Promise<void>((resolve) => stream.onAbort(resolve))
        }),
    )
    return app
}

export async function startWeb(opts: {
    bus: EventBus
    manager: FleetManager
    host: string
    port: number
    demo: boolean
    onListening?: (address: AddressInfo) => void
}): Promise<() => Promise<void>> {
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
        opts.bus.emit('log', {
            level: 'warn',
            message: `web dashboard exposed on ${opts.host}:${opts.port}: it shows your whole fleet's state; keep it on 127.0.0.1 unless you mean it`,
        })
    }
    const app = createWebApp(opts)
    /**
     * AWAITED, not fired and forgotten. `serve()` returns the server synchronously and calls its
     * listening callback later, so an un-awaited `startWeb` resolves BEFORE the socket is bound: the
     * caller gets a stop function for a server that has not started, `onListening` has not run, and
     * `EADDRINUSE` — the realistic failure, a partner with something else on 4310 — surfaces as an
     * unhandled `error` event instead of a rejection `startWith` can catch and shut down cleanly.
     * The `error` listener is dropped once we are listening, so a later server error is not swallowed
     * by a rejection handler for a promise that has already settled.
     */
    let server: ServerType
    try {
        server = await new Promise<ServerType>((resolveServer, rejectServer) => {
            const created = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }, (address) => {
                created.off('error', rejectServer)
                opts.onListening?.(address)
                opts.bus.emit('log', {
                    level: 'info',
                    message: `web dashboard on http://${address.address}:${address.port}${opts.demo ? ' (DEMO MODE — not connected to remi)' : ''}`,
                })
                resolveServer(created)
            })
            created.once('error', rejectServer)
        })
    } catch (error) {
        // The bus subscription was taken before the bind was attempted; a port that is already in use
        // must not leave it folding events into a model that now has no server to serve it.
        app.close()
        throw error
    }
    return () =>
        new Promise<void>((resolve, reject) => {
            app.close()
            server.close((error) => (error ? reject(error) : resolve()))
            /**
             * An SSE response never ends by itself, and `server.close()` waits for every open one: a
             * partner with the dashboard open in a browser would press Ctrl+C and watch `efk start`
             * hang for ever, with `manager.stop()` — and therefore `seq.flush()` — never reached.
             * Destroying the sockets is also what ends each stream, which is what fires its
             * `onAbort` and clears the 2 s snapshot timer holding the event loop open.
             * `closeAllConnections` lives on node's `http.Server`; the http2 members of `ServerType`
             * do not declare it, hence the guard.
             */
            if ('closeAllConnections' in server) server.closeAllConnections()
        })
}
