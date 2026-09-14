/**
 * The web dashboard: the same four views as the TUI, over SSE, for demos and for whoever is not at
 * the terminal — and, now, the same four manual fault controls the TUI has (available/door/link/
 * blocked), for the same reason the TUI has them: a partner working a scenario without a terminal
 * still needs to flip a bot's battery-starved availability, jam a door, pin a link down, or force a
 * `blocked` event. Binds to 127.0.0.1 by default.
 *
 * THIS CROSSES DESIGN §8 ON PURPOSE ("TUI, web and log are observers of the bus; no logic lives in
 * them"). The TUI already crossed it (Task 12); the web now does too, deliberately — see the kit's
 * README, web section, and `../core/manual-controls`, where the logic itself lives so neither
 * interface has its own copy to drift from the other's.
 *
 * THE SECURITY CONSEQUENCE IS STRUCTURAL, NOT A WARNING. A read-only dashboard exposed on
 * `0.0.0.0` only leaked state; this repository is public, so a warning in a startup log protects
 * nothing against someone who has simply read this file — which is everyone. So the control routes
 * below are MOUNTED ONLY when the dashboard binds to loopback (`isLoopbackHost`); on any other host
 * they do not exist — a request to them 404s exactly as it would for a path nobody ever wrote,
 * not "exists but refuses". `snapshot().controlsEnabled` carries the same decision to the page, so
 * the UI can render the controls as absent-with-a-reason instead of present-and-broken. It is a
 * different server from the HTTP transport, which MUST listen on 0.0.0.0 because remi calls it.
 */
import type { AddressInfo } from 'node:net'
import { type ServerType, serve } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { EventBus, EventName, KitEvents } from '../core/events'
import type { FleetManager } from '../core/fleet-manager'
import { controlsFor, guardToggle, linkLabel, nextOfflinePin, type ToggleResult, toggleAvailable } from '../core/manual-controls'
import type { DoorState } from '../driver/robot-driver'
import { applyReplay, botRows, createModel, reduce, type TuiModel } from '../tui/model'
import { PAGE_HTML } from './page'

const SNAPSHOT_EVERY_MS = 2_000

/**
 * The one predicate both the mounting decision and the startup warning are built on, so they cannot
 * disagree about what counts as "exposed". `127.0.0.1` and `::1` are the loopback literals; `localhost`
 * is included because the CLI's own default warning already treated it as safe and nothing here
 * resolves DNS to double-check that a partner has not repointed it.
 */
export function isLoopbackHost(host: string): boolean {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

export function createWebApp(deps: {
    bus: EventBus
    manager: FleetManager
    demo?: boolean
    /** Defaults to loopback: every existing caller that omits it is the CLI's own `127.0.0.1` default. */
    host?: string
}): Hono & { close(): void } {
    const controlsEnabled = isLoopbackHost(deps.host ?? '127.0.0.1')

    /**
     * Seeded from what the bus buffered BEFORE this dashboard existed, exactly as the TUI does. The
     * lines that happen first are the ones that explain a start that went wrong — the roster, the
     * capabilities, the first CONNECT — and the `DEMO MODE` warning itself is among them, so a
     * dashboard that began at "now" opened with a LOG table that was silent about the one thing it
     * must never be silent about. `applyReplay` also states the bus's `dropped` count as a line of
     * its own when the replay buffer overflowed, instead of leaving a gap to be inferred.
     *
     * Read BEFORE subscribing, and with nothing awaited in between: `replay()` returns everything
     * buffered so far, so subscribing first would fold anything emitted between the two statements
     * twice.
     */
    let model: TuiModel = applyReplay(createModel(), deps.bus.replay(), Date.now())
    // Kept so `close()` can drop it: an app that outlives its server and keeps folding every bus
    // event into a model nobody reads is a leak that grows for as long as `efk start` runs.
    const offBus = deps.bus.onAny((name, payload) => {
        model = reduce(model, name, payload as never, Date.now())
    })

    /**
     * What the driver itself cannot tell us back: the TUI keeps these two in a `useState` per browser
     * tab; the web dashboard has no tab; it has this process, so the pin and the manual `blocked` flag
     * live here, one entry per bot, for as long as `efk start` runs. Same shape as `App.tsx`'s
     * `offline`/`blocked` state, moved from a component's memory to the server's.
     */
    const linkPins = new Map<string, boolean | null>()
    const blockedFlags = new Map<string, boolean>()

    const botCapabilities = (botId: string): { hasControls: boolean; hasDoor: boolean } => {
        const hasControls = controlsFor(deps.manager, botId) !== null
        let hasDoor = false
        try {
            hasDoor = deps.manager.driver(botId)?.capabilities().hasDoor === true
        } catch {
            hasDoor = false
        }
        return { hasControls, hasDoor }
    }

    const snapshot = () => {
        const now = Date.now()
        return {
            namespace: deps.manager.config()?.namespace ?? null,
            demo: deps.demo === true,
            /**
             * The structural guard, restated for the page: when this is `false` the four control
             * routes below do not exist on this server at all (see module doc), and the UI should say
             * so rather than render buttons that will 404.
             */
            controlsEnabled,
            bots: botRows(deps.manager, model, now).map((row) => ({ ...row, ...botCapabilities(row.botId) })),
            commands: model.commands.slice(0, 100),
            events: model.events.slice(0, 100),
            log: model.log.slice(0, 200),
        }
    }

    const app = new Hono() as Hono & { close(): void }
    app.close = offBus
    app.get('/', (c) => c.html(PAGE_HTML))
    /**
     * SEVEN keys now, `controlsEnabled` joining `namespace` and `demo`. An earlier shape stripped the
     * latter two, which put the page and its own data source in contradiction: `render()` reads
     * `s.demo` to raise the red DEMO band, and this is the response it renders FIRST — the band then
     * depended entirely on the SSE snapshot arriving. The window where it does not is narrow (a proxy
     * that blocks SSE, the browser's per-origin connection limit, a restart) but in it the partner's
     * only cue that everything on screen is invented is simply absent, and `es.onerror` merely reddens
     * the `h1` with no text. A contradiction between two pieces of the design resolves in favour of
     * never letting a partner believe they are talking to remi — or, now, believe a control exists
     * that this server will 404 on.
     */
    app.get('/api/snapshot', (c) => c.json(snapshot()))
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

    if (controlsEnabled) mountControls(app, deps.manager, linkPins, blockedFlags)

    return app
}

type ControlFailure = { ok: false; error: 'bot_not_found' | 'no_controls' | 'no_door' | 'driver_error'; note?: string | null }

function findBot(manager: FleetManager, botId: string) {
    try {
        return manager.bots().find((b) => b.botId === botId)
    } catch {
        return undefined
    }
}

/**
 * The four control routes, mounted ONLY when `createWebApp` decided `controlsEnabled` — see the
 * module doc for why that is a mount-time decision and not a per-request refusal. Every action goes
 * through `guardToggle` (`../core/manual-controls`): a driver that throws costs that one request and
 * a note in the body, never a 500 that could carry whatever the driver's exception was holding —
 * `guardToggle`/`describeThrown` are what keep that promise, same as they do for the TUI's keyboard.
 */
function mountControls(app: Hono, manager: FleetManager, linkPins: Map<string, boolean | null>, blockedFlags: Map<string, boolean>): void {
    const preface = (c: { req: { param: (name: string) => string } }): { botId: string; runtime: ReturnType<typeof findBot> } => {
        const botId = c.req.param('botId')
        return { botId, runtime: findBot(manager, botId) }
    }

    app.post('/api/bots/:botId/controls/available', (c) => {
        const { botId, runtime } = preface(c)
        if (!runtime) return c.json<ControlFailure>({ ok: false, error: 'bot_not_found' }, 404)
        const controls = controlsFor(manager, botId)
        if (!controls) return c.json<ControlFailure>({ ok: false, error: 'no_controls' }, 422)
        let result: ToggleResult | null = null
        const failNote = guardToggle(botId, () => {
            result = toggleAvailable(controls, runtime)
        })
        if (failNote !== null) return c.json<ControlFailure>({ ok: false, error: 'driver_error', note: failNote }, 503)
        const r = result as unknown as ToggleResult
        return c.json({ ok: true as const, requested: r.requested, applied: r.applied, note: r.note })
    })

    app.post('/api/bots/:botId/controls/door', (c) => {
        const { botId, runtime } = preface(c)
        if (!runtime) return c.json<ControlFailure>({ ok: false, error: 'bot_not_found' }, 404)
        const controls = controlsFor(manager, botId)
        if (!controls) return c.json<ControlFailure>({ ok: false, error: 'no_controls' }, 422)
        let hasDoor = false
        const capNote = guardToggle(botId, () => {
            hasDoor = manager.driver(botId)?.capabilities().hasDoor === true
        })
        if (capNote !== null) return c.json<ControlFailure>({ ok: false, error: 'driver_error', note: capNote }, 503)
        // Refused with a reason, not pretended: the simulated driver's `toggleDoorLocally` does not
        // throw on a doorless bot, it silently no-ops, so the check has to happen out here.
        if (!hasDoor) return c.json<ControlFailure>({ ok: false, error: 'no_door', note: `${botId} has no door` }, 422)
        let door: DoorState | null = null
        const note = guardToggle(botId, () => {
            controls.toggleDoorLocally()
            runtime.touch()
            door = runtime.snapshot().door
        })
        if (note !== null) return c.json<ControlFailure>({ ok: false, error: 'driver_error', note }, 503)
        return c.json({ ok: true as const, door, note: null as string | null })
    })

    app.post('/api/bots/:botId/controls/link', (c) => {
        const { botId, runtime } = preface(c)
        if (!runtime) return c.json<ControlFailure>({ ok: false, error: 'bot_not_found' }, 404)
        const controls = controlsFor(manager, botId)
        if (!controls) return c.json<ControlFailure>({ ok: false, error: 'no_controls' }, 422)
        // THREE states, not two (see `nextOfflinePin`): only cycling back to `null` returns this bot
        // to its scenario, which is why the pin lives here across requests instead of being derived
        // fresh from `connected` on every call.
        const next = nextOfflinePin(linkPins.get(botId) ?? null)
        let connected = false
        const note = guardToggle(botId, () => {
            controls.setOffline(next)
            runtime.touch()
            connected = runtime.snapshot().connected
        })
        if (note !== null) return c.json<ControlFailure>({ ok: false, error: 'driver_error', note }, 503)
        linkPins.set(botId, next)
        return c.json({ ok: true as const, pin: next, connected, label: linkLabel(connected, next), note: null as string | null })
    })

    app.post('/api/bots/:botId/controls/blocked', (c) => {
        const { botId, runtime } = preface(c)
        if (!runtime) return c.json<ControlFailure>({ ok: false, error: 'bot_not_found' }, 404)
        const controls = controlsFor(manager, botId)
        if (!controls) return c.json<ControlFailure>({ ok: false, error: 'no_controls' }, 422)
        const next = !(blockedFlags.get(botId) ?? false)
        const note = guardToggle(botId, () => {
            if (next) controls.emitBlocked('operator_test', 'blocked from the efk web dashboard')
            else controls.emitUnblocked()
        })
        if (note !== null) return c.json<ControlFailure>({ ok: false, error: 'driver_error', note }, 503)
        blockedFlags.set(botId, next)
        return c.json({ ok: true as const, blocked: next, note: null as string | null })
    })
}

export async function startWeb(opts: {
    bus: EventBus
    manager: FleetManager
    host: string
    port: number
    demo: boolean
    onListening?: (address: AddressInfo) => void
}): Promise<() => Promise<void>> {
    if (!isLoopbackHost(opts.host)) {
        opts.bus.emit('log', {
            level: 'warn',
            message:
                `web dashboard exposed on ${opts.host}:${opts.port}: your whole fleet's state is visible to the network. ` +
                'The manual controls (available/door/link/blocked) are DISABLED on this host — they only mount on ' +
                'loopback — so exposure here leaks state, it cannot be used to move a door or drop a link. ' +
                'Keep it on 127.0.0.1 unless you mean it.',
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
