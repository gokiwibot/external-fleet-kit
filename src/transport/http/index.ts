import { type ServerType, serve } from '@hono/node-server'
import type { BotCommand, BotEvent, BotState } from '../../contract/schemas'
import type { BotRuntime } from '../../core/bot-runtime'
import type { CommandOutcome, EventBus } from '../../core/events'
import type { ServedState } from '../../core/fleet-manager'
import type { RemiClient } from '../../remi/client'
import type { Transport } from '../transport'
import { createPushClient } from './push'
import { createPartnerApp } from './server'

export type HttpTransportDeps = {
    port: number
    token: string
    bus: EventBus
    push: boolean
    /**
     * `FleetManager.serve()`, and nothing hand-rolled: it is the poll path, so it is also the only
     * thing that drains the command ledger while push is off (the default). Wire it as
     * `serveFleet: () => manager.serve()` — the closure is what breaks the cycle, since the manager
     * builds the transport during its own `start()`. Named apart from `serve` below, which is the
     * unrelated listener from `@hono/node-server`.
     */
    serveFleet: () => ServedState[]
    remi?: RemiClient
    /** Injected in tests so the transport can be exercised without binding a port. */
    serve?: typeof serve
}

/**
 * HTTP transport: serves the partner endpoints on 0.0.0.0:HTTP_PORT (remi must reach it) and, with
 * push on, forwards the tick's batch of states and each event to remi. `publishState` answers false
 * either way: without push nothing is sent at all — remi reads the state from `GET /bots` — and with
 * push the state has merely joined this tick's batch. What counts as published is the batch remi
 * really took, confirmed one state at a time in `flushTick`.
 */
export function createHttpTransport(deps: HttpTransportDeps): Transport {
    let server: ServerType | null = null
    let runtimes: BotRuntime[] = []
    const push = deps.push && deps.remi ? createPushClient({ remi: deps.remi, bus: deps.bus }) : null
    let handler: ((botId: string, command: BotCommand) => Promise<CommandOutcome>) | null = null
    /** The tick's states, each with the runtime that will be told when — and only when — they land. */
    let batch: Array<{ runtime: BotRuntime; state: BotState }> = []
    /** Whether the last batch reached remi. Only a false→true edge is a recovery; see `flushTick`. */
    let pushDelivering = true
    /** Said once per run: with push off an event has nowhere to go, and silence looks like a bug. */
    let eventsDroppedWarned = false

    return {
        kind: 'http',
        async start(bots) {
            runtimes = bots
            const app = createPartnerApp({
                token: deps.token,
                // The app calls the handler the manager wired through `onCommand`, and falls back to
                // the runtime only if nothing was wired. The previous `void handler` left the handler
                // dead: commands bypassed whatever the manager had registered, so anything the
                // manager wants to do around a command (the unknown-bot answer, future middleware)
                // simply did not happen in HTTP mode.
                bots: () => runtimes,
                serve: deps.serveFleet,
                onCommand: (botId, command) => {
                    if (handler) return handler(botId, command)
                    const runtime = runtimes.find((r) => r.botId === botId)
                    if (!runtime)
                        return Promise.resolve<CommandOutcome>({
                            kind: 'rejected',
                            code: 'UNSUPPORTED_COMMAND',
                            message: `unknown bot ${botId}`,
                        })
                    return runtime.handleCommand(command, 'http')
                },
                bus: deps.bus,
            })
            server = (deps.serve ?? serve)({ fetch: app.fetch, port: deps.port, hostname: '0.0.0.0' })
            deps.bus.emit('log', { level: 'info', message: `partner HTTP surface listening on 0.0.0.0:${deps.port}` })
        },
        // The app reads the fleet through `bots: () => runtimes`, so replacing the array is the whole
        // update: the next `GET /bots` answers with the fleet as it is now, and a command for a bot
        // that has just left gets the same `unknown bot` a never-registered one gets.
        async setBots(bots) {
            runtimes = bots
        },
        async stop() {
            if (batch.length > 0) {
                // NOT flushed on the way out, and above all not confirmed: these states never reached
                // remi, so the outcomes they carry must stay owed rather than be marked delivered by
                // a process that is shutting down.
                deps.bus.emit('log', {
                    level: 'warn',
                    message: `stopped with ${batch.length} state(s) still waiting for a flush; they are dropped unconfirmed, so nothing counts as published that did not leave`,
                })
                batch = []
            }
            const listening = server
            server = null
            if (!listening) return
            await new Promise<void>((resolve) => {
                listening.close(() => resolve())
            })
        },
        async publishState(botId, state: BotState) {
            // Accumulate; the manager closes the tick with flushTick() and the whole fleet goes in one
            // request. Without push there is nothing to send at all: remi polls.
            if (!push) return false
            const runtime = runtimes.find((r) => r.botId === botId)
            if (!runtime) return false
            batch.push({ runtime, state })
            // FALSE, even though this state is on its way out. A buffer in this process is not remi:
            // the batch can still be skipped, superseded or given up on, and answering `true` here
            // would consume the `seq` and drain the outcome from the ledger for bytes that never
            // left — the very harm the poll path is guarded against. `flushTick` confirms what lands.
            return false
        },
        async publishEvent(botId, event: BotEvent) {
            if (!push) {
                if (!eventsDroppedWarned) {
                    eventsDroppedWarned = true
                    deps.bus.emit('log', {
                        level: 'warn',
                        botId,
                        message: `dropping the ${event.type} event: HTTP polling has no events channel — remi reads state from GET /bots and only receives events with HTTP_PUSH=true. Said once per run.`,
                    })
                }
                return false
            }
            return await push.pushEvent(event)
        },
        async flushTick() {
            if (!push || batch.length === 0) return
            const pending = batch
            batch = []
            const delivered = await push.pushState(pending.map((entry) => entry.state))
            // THE DEFERRED CONFIRMATION. Only here does a state count as published: the seq is
            // consumed and the ledger drained through `confirmPublished`, and `state.published` is
            // emitted for the ones that took — the manager cannot emit it for this transport, because
            // `publishState` truthfully answered `false` a moment ago. A batch that was skipped or
            // given up on falls through all of this: nothing confirmed, nothing spent, nothing lost.
            if (delivered) {
                for (const entry of pending) {
                    if (entry.runtime.confirmPublished(entry.state)) {
                        deps.bus.emit('state.published', { botId: entry.runtime.botId, state: entry.state, transport: 'http' })
                    }
                }
            }
            // RECOVERY. A push that starts landing again after a run of failures (remi down, or a
            // flight so slow the batches were being skipped) is this transport's reconnection, and it
            // owes the fleet the same thing MQTT owes a reopened connection: a `touch()`, so the next
            // 250 ms tick carries a fresh state instead of leaving remi with what it last got until
            // the 15 s idle heartbeat comes round.
            if (delivered && !pushDelivering) {
                for (const runtime of runtimes) runtime.touch()
                deps.bus.emit('log', {
                    level: 'info',
                    message: 'push to remi is landing again; publishing the whole fleet on the next tick',
                })
            }
            pushDelivering = delivered
        },
        onCommand(fn) {
            handler = fn
        },
    }
}
