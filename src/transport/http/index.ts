import { type ServerType, serve } from '@hono/node-server'
import type { BotCommand, BotEvent, BotState, FleetCapabilities } from '../../contract/schemas'
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
 * push on, forwards the tick's batch of states and each event to remi. Without push, `publishState`
 * delivers nothing — it returns false, and remi reads the state from `GET /bots` instead.
 */
export function createHttpTransport(deps: HttpTransportDeps): Transport {
    let server: ServerType | null = null
    let runtimes: BotRuntime[] = []
    let capabilities: FleetCapabilities = { supports_command_interrupt: true, default: { has_door: false, supported_commands: [] } }
    const push = deps.push && deps.remi ? createPushClient({ remi: deps.remi, bus: deps.bus }) : null
    let handler: ((botId: string, command: BotCommand) => Promise<CommandOutcome>) | null = null
    let batch: BotState[] = []
    /** Whether the last batch reached remi. Only a false→true edge is a recovery; see `flushTick`. */
    let pushDelivering = true

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
                capabilities: () => capabilities,
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
        async stop() {
            const listening = server
            server = null
            if (!listening) return
            await new Promise<void>((resolve) => {
                listening.close(() => resolve())
            })
        },
        async publishState(_botId, state: BotState) {
            // Accumulate; the manager closes the tick with flushTick() and the whole fleet goes in one
            // request. Without push there is nothing to send at all: remi polls.
            if (!push) return false
            batch.push(state)
            return true
        },
        async publishEvent(_botId, event: BotEvent) {
            if (!push) return false
            await push.pushEvent(event)
            return true
        },
        async flushTick() {
            if (!push || batch.length === 0) return
            const states = batch
            batch = []
            const delivered = await push.pushState(states)
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
        async publishCapabilities(doc) {
            capabilities = doc
        },
        onCommand(fn) {
            handler = fn
        },
    }
}
