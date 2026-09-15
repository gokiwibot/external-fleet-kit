/**
 * The fleet manager (design §9): discovers the roster from remi, builds one BotRuntime per bot, wires
 * the transport, sends the capabilities document to remi, and runs the 250 ms tick that asks each
 * runtime whether it has a state to publish. Nothing here knows how a robot moves (driver) or how
 * bytes travel (transport).
 *
 * THE TWO DELIVERY PATHS. A state reaches remi in one of two ways, and both of them end in the
 * ledger's queue of unpublished outcomes being drained — that queue is how the kit keeps the promise
 * that remi learns the outcome of every command it issued (CommandLedger, THE SINGLE SLOT).
 *  - PUSH (`tick`): the transport carries the state out and says whether it left. MQTT, and HTTP with
 *    push on.
 *  - POLL (`serve`): remi asks `GET /bots` and the answer IS the delivery. HTTP with push off — the
 *    default — publishes nothing at all, so without this path the queue would never drain and every
 *    outcome would strand behind the oldest one.
 */
import {
    type BotCapabilities,
    type BotState,
    type FleetCapabilities,
    type FleetConfigResponse,
    fleetCapabilitiesSchema,
} from '../contract/schemas'
import type { RobotDriver } from '../driver/robot-driver'
import { describeThrown } from '../net-failure'
import type { RemiClient } from '../remi/client'
import type { Transport } from '../transport/transport'
import { type BotRuntime, createBotRuntime } from './bot-runtime'
import { createCadence, TICK_MS } from './cadence'
import { createCommandLedger } from './command-ledger'
import type { EventBus } from './events'
import type { Seq } from './seq'

export type StartResult =
    | { ok: true; roster: string[] }
    | { ok: false; reason: 'empty_roster' | 'transport_mismatch' | 'remi_error' | 'driver_version'; detail: string }

/**
 * One line of the answer to a poll. `stale` marks a state served from `lastValidState()` — the bot is
 * in the list, but its `timestamp` is older than this poll and remi reads the age from there.
 * A bot that has never had a position is absent from the array; the caller counts the difference
 * against `bots().length` if it wants to report it.
 */
export type ServedState = { botId: string; state: BotState; stale: boolean }

export type FleetManagerDeps = {
    remi: RemiClient
    /** The config is the second argument because the MQTT transport needs `namespace`, and only this module has read it. */
    transportFor: (kind: 'mqtt' | 'http', config: FleetConfigResponse) => Transport
    driverFor: (botId: string) => RobotDriver
    fleet: { supportsCommandInterrupt: boolean }
    env: { transport: 'mqtt' | 'http' }
    bus: EventBus
    seq: Seq
    now: () => number
    /** 0 disables the interval (tests call tickOnce()). */
    tickMs?: number
}

export interface FleetManager {
    start(): Promise<StartResult>
    stop(): Promise<void>
    bots(): BotRuntime[]
    /** The driver behind a bot, for observers that need it (the TUI's manual fault keys). */
    driver(botId: string): RobotDriver | undefined
    config(): FleetConfigResponse | null
    capabilities(): FleetCapabilities
    tickOnce(): Promise<void>
    /**
     * The poll path: the whole fleet's current states, each acknowledged as delivered. This is what
     * `GET /bots` answers with (Task 14) and the ONLY way the ledger drains in HTTP polling mode.
     * The returned states carry no `seq`, because a poll consumes no counter (`data.ts:676`).
     */
    serve(): ServedState[]
}

export function createFleetManager(deps: FleetManagerDeps): FleetManager {
    let runtimes: BotRuntime[] = []
    const drivers = new Map<string, RobotDriver>()
    const subscriptions: Array<() => void> = []
    let transport: Transport | null = null
    let config: FleetConfigResponse | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let ticking = false
    /**
     * The tick that is running RIGHT NOW, so `stop()` can await it before flushing the counters.
     *
     * ORDERLY SHUTDOWN. `stop()` used to clear the interval and walk straight on to `seq.flush()`,
     * which does not stop a tick that had already started: a QoS 1 publish still waiting for its
     * PUBACK, or an HTTP batch still in `flushTick`, confirms a moment later and consumes a `seq`
     * AFTER the counters have been written to disk. That increment never reaches `.efk-state.json`,
     * so the next run hands that bot a number it has already used and remi — which discards any
     * state whose `seq` is not above the last one it stored — drops the state it is sent.
     */
    let inFlight: Promise<void> | null = null
    const tickMs = deps.tickMs ?? TICK_MS

    const buildCapabilities = (): FleetCapabilities => {
        const first = runtimes[0]
        const fallback: BotCapabilities = { has_door: false, supported_commands: [] }
        const def = first ? first.capabilities() : fallback
        const overrides: Record<string, Partial<BotCapabilities>> = {}
        for (const runtime of runtimes.slice(1)) {
            const caps = runtime.capabilities()
            if (JSON.stringify(caps) !== JSON.stringify(def)) overrides[runtime.botId] = caps
        }
        const doc: FleetCapabilities = { supports_command_interrupt: deps.fleet.supportsCommandInterrupt, default: def }
        if (Object.keys(overrides).length > 0) doc.overrides = overrides
        return fleetCapabilitiesSchema.parse(doc)
    }

    /**
     * One tick: ask every runtime whether it has a state due, hand each to the transport, then close
     * the tick once. `flushTick` is what lets the HTTP transport send ONE `POST /state` with the whole
     * batch instead of one request per bot — 200 bots at 4 Hz would otherwise be 800 requests a second
     * at remi. It is also serialised with `ticking`: without that, a slow flush overlaps the next tick
     * and the retries pile up on each other.
     *
     * The transport travels INTO `runtime.tick()` (Task 6, THE PUBLISH SEAM): the runtime consumes the
     * `seq` and drains the ledger only for a state the transport confirmed, and hands that state back.
     * A null answer means the tick was not due, the state did not assemble, or the transport refused
     * it — in all three cases nothing was published, so `state.published` must not fire.
     */
    const tick = async () => {
        if (ticking) return
        ticking = true
        try {
            const nowMs = deps.now()
            for (const runtime of runtimes) {
                const pipe = transport
                if (!pipe) continue
                try {
                    const state = await runtime.tick(nowMs, (candidate) => pipe.publishState(runtime.botId, candidate))
                    if (state) deps.bus.emit('state.published', { botId: runtime.botId, state, transport: pipe.kind })
                } catch (error) {
                    deps.bus.emit('log', { level: 'error', botId: runtime.botId, message: `publish failed: ${describeThrown(error)}` })
                }
            }
            try {
                await transport?.flushTick()
            } catch (error) {
                deps.bus.emit('log', { level: 'error', message: `push batch failed: ${describeThrown(error)}` })
            }
        } finally {
            ticking = false
        }
    }

    const serve = (): ServedState[] => {
        const nowMs = deps.now()
        const answer: ServedState[] = []
        for (const runtime of runtimes) {
            const result = runtime.assemble(nowMs)
            if (result.ok) {
                // The poll IS the delivery, so this acknowledges it: the ledger pops the outcome remi
                // has now seen, and no `seq` is consumed because the served state carries none.
                runtime.markServed(result.state)
                deps.bus.emit('state.served', { botId: runtime.botId, state: result.state })
                answer.push({ botId: runtime.botId, state: result.state, stale: false })
                continue
            }
            // NEVER `markServed` the fallback (BotRuntime.markServed). Two distinct harms, and the
            // first one is the one that bites here: this snapshot is refreshed by every successful
            // assembly, including a tick whose transport REFUSED the state, so it can carry an
            // outcome remi has not seen. Acknowledging it would pop that outcome off the queue for a
            // state that never left the process, and remi would never learn how the command it
            // issued ended. The second is the one Task 6 documents: with the queue empty it would
            // move the ledger's `lastPublishedId` backwards onto a superseded command.
            // Serve it, acknowledge nothing.
            const fallback = runtime.lastValidState()
            if (fallback) answer.push({ botId: runtime.botId, state: fallback, stale: true })
        }
        return answer
    }

    return {
        async start() {
            const fleet = await deps.remi.getFleetConfig()
            if (!fleet.ok)
                return { ok: false, reason: 'remi_error', detail: `GET /api/v3/fleet → ${fleet.status} ${fleet.code}: ${fleet.message}` }
            if (fleet.data.transport !== deps.env.transport) {
                return {
                    ok: false,
                    reason: 'transport_mismatch',
                    detail: `remi expects ${fleet.data.transport} and your .env says ${deps.env.transport}; ask Robot.com to change it or fix the .env`,
                }
            }
            const roster = await deps.remi.listFleetBots()
            if (!roster.ok)
                return {
                    ok: false,
                    reason: 'remi_error',
                    detail: `GET /api/v3/fleet/bots → ${roster.status} ${roster.code}: ${roster.message}`,
                }
            const ids = roster.data.filter((b) => !b.blocked_by.includes('retired')).map((b) => b.bot_id)
            if (ids.length === 0)
                return {
                    ok: false,
                    reason: 'empty_roster',
                    detail: 'Robot.com has not registered your bots yet (GET /api/v3/fleet/bots returned 0)',
                }
            if (ids.length > fleet.data.max_bots) {
                deps.bus.emit('log', {
                    level: 'warn',
                    message: `roster has ${ids.length} bots but max_bots is ${fleet.data.max_bots}; serving the first ${fleet.data.max_bots}`,
                })
            }
            // NOTHING below is written to the manager's own state until the whole fleet has been
            // built. A `start()` that answers `ok: false` must leave the manager exactly as it found
            // it: `runtimes.push` appends, so a CLI retrying a transient failure would otherwise be
            // handed a SECOND fleet stacked on the half-built first one, and `bots()` would report a
            // fleet for a start that failed.
            const built: BotRuntime[] = []
            const builtDrivers = new Map<string, RobotDriver>()
            for (const botId of ids.slice(0, fleet.data.max_bots)) {
                const driver = deps.driverFor(botId)
                if (driver.driverVersion !== 1)
                    return {
                        ok: false,
                        reason: 'driver_version',
                        detail: `driver for ${botId} implements version ${String(driver.driverVersion)}, the kit needs 1`,
                    }
                builtDrivers.set(botId, driver)
                built.push(
                    createBotRuntime({
                        botId,
                        driver,
                        ledger: createCommandLedger({
                            now: deps.now,
                            // The queue of unpublished outcomes is bounded (MAX_UNPUBLISHED_TERMINALS)
                            // and drops the OLDEST when it overflows. remi is entitled to the outcome
                            // of every command it issued, so a drop is said out loud: unwired, the kit
                            // would discard exactly what the bound exists to make visible.
                            onTerminalDropped: (id, pending) =>
                                deps.bus.emit('log', {
                                    level: 'warn',
                                    botId,
                                    message: `dropped the outcome of ${id}: ${pending} still waiting to be published`,
                                }),
                        }),
                        cadence: createCadence(),
                        seq: deps.seq,
                        bus: deps.bus,
                        now: deps.now,
                        fleet: deps.fleet,
                    }),
                )
            }

            // The commit point: from here the start can no longer answer `ok: false`. The fleet has
            // to be visible BEFORE `transport.start()` subscribes — a broker that has a command
            // waiting delivers it the moment we subscribe, and an empty `runtimes` would answer that
            // command with `unknown bot`. `config()` is published here too, so it describes a fleet
            // that exists rather than a start that failed.
            runtimes = built
            for (const [botId, driver] of builtDrivers) drivers.set(botId, driver)
            config = fleet.data

            transport = deps.transportFor(deps.env.transport, fleet.data)
            transport.onCommand(async (botId, command) => {
                const runtime = runtimes.find((r) => r.botId === botId)
                if (!runtime) return { kind: 'rejected', code: 'UNSUPPORTED_COMMAND', message: `unknown bot ${botId}` }
                return runtime.handleCommand(command, transport?.kind ?? 'mqtt')
            })

            // Subscribe BEFORE the drivers start. A driver that emits `blocked` inside start() — a
            // real one reading its first telemetry frame does exactly that — would otherwise fire
            // into a bus nobody is listening to, and that event is simply lost.
            subscriptions.push(
                deps.bus.on('event.emitted', (e) => {
                    if (e.delivered || !transport) return
                    transport.publishEvent(e.botId, e.event).catch((error: unknown) =>
                        deps.bus.emit('log', {
                            level: 'error',
                            botId: e.botId,
                            message: `event publish failed: ${describeThrown(error)}`,
                        }),
                    )
                }),
            )

            for (const runtime of runtimes) await runtime.start()
            await transport.start(runtimes)
            // A failure here must not stop the fleet: a fleet with no capabilities document on file
            // still runs on remi's default behaviour, and refusing to start would be a worse outcome
            // than starting without it.
            const sent = await deps.remi.setCapabilities(buildCapabilities())
            if (!sent.ok)
                deps.bus.emit('log', {
                    level: 'error',
                    message: `sending capabilities to remi failed: ${sent.status} ${sent.code}: ${sent.message}; the fleet is starting anyway on remi's default behaviour`,
                })
            if (tickMs > 0)
                timer = setInterval(() => {
                    const run = tick()
                    inFlight = run
                    // `then(clear, clear)` and not `finally`: it settles the promise either way, so a
                    // tick that rejects cannot become an unhandled rejection — which `void tick()`
                    // left open — and cannot strand `inFlight` on a promise that never clears.
                    const clear = () => {
                        if (inFlight === run) inFlight = null
                    }
                    run.then(clear, clear)
                }, tickMs)
            return { ok: true, roster: runtimes.map((r) => r.botId) }
        },
        async stop() {
            if (timer) clearInterval(timer)
            timer = null
            // BEFORE anything else, and above all before `seq.flush()` below: see `inFlight`. The
            // rejection is swallowed because this is the shutdown path and the tick already reported
            // its own failures on the bus; what matters here is that it has FINISHED.
            await inFlight?.catch(() => {})
            inFlight = null
            for (const off of subscriptions.splice(0)) off()
            for (const runtime of runtimes) await runtime.stop()
            await transport?.stop()
            // The persisted counters survive the process only if they are flushed here (Seq, Task 3).
            deps.seq.flush()
            runtimes = []
            drivers.clear()
            transport = null
        },
        bots: () => runtimes,
        driver: (botId) => drivers.get(botId),
        config: () => config,
        capabilities: buildCapabilities,
        tickOnce: tick,
        serve,
    }
}
