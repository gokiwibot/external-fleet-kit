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
 *
 * THE ROSTER IS RE-READ, NOT FROZEN (`reconcile`). remi owns the roster and may change it at any
 * time — a bot registered, retired, remapped, or pushed past `max_bots`. This process follows those
 * changes on its own cadence instead of requiring a restart, and it touches ONLY the bots that
 * changed: an untouched bot keeps its runtime, its ledger and its driver, so a fleet that is
 * delivering never notices the ones next to it being added or dropped. Two rules make that safe and
 * they are the whole of it:
 *  - A REFRESH NEVER PARKS THE FLEET. The idle rules below (no credentials, an unmapped bot, an
 *    empty roster) decide whether this process starts at all; applying them in flight would tear
 *    down robots that are mid-delivery because somebody added a bad row. On a refresh an
 *    undriveable bot is simply not driven, and it is said out loud.
 *  - A BUSY BOT IS NEVER REBUILT. Rebuilding is stop + build, which drops that bot's ledger and its
 *    driver's view of the mission in flight. remi already refuses to remap a bot that holds a job,
 *    so this is the belt to that braces: if the bot is running a command anyway, the change waits
 *    for the next pass.
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

/**
 * How often the roster is re-read. The same 15 s remi uses to refresh ITS view of the fleet, so
 * the two sides converge on a change within one cadence of each other and neither is the one that
 * looks stale.
 */
export const ROSTER_REFRESH_MS = 15_000

export type StartResult =
    | { ok: true; roster: string[] }
    // No `empty_roster`: an empty roster is an idle start, not a failed one (see `start` below).
    | { ok: false; reason: 'transport_mismatch' | 'remi_error' | 'driver_version'; detail: string }

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
    /** `fleetSerial` comes from remi's roster (`bots.fleet_serial`); null means derive it from the id. */
    driverFor: (botId: string, fleetSerial: string | null) => RobotDriver
    /**
     * Asked once per `start()`, BEFORE `driverFor` is called for anything: a sentence means the
     * driver cannot build bots yet and the fleet starts idle (see `start`). The kit cannot work this
     * out itself — it is whatever the driver needs beyond the kit's own `.env`, so the driver says.
     */
    driverUnavailable?: () => string | null
    fleet: { supportsCommandInterrupt: boolean }
    env: { transport: 'mqtt' | 'http' }
    bus: EventBus
    seq: Seq
    now: () => number
    /** 0 disables the interval (tests call tickOnce()). */
    tickMs?: number
    /** 0 disables the roster loop (tests call reconcileOnce()). */
    rosterRefreshMs?: number
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
    /** One pass of the roster loop. Exposed so tests can drive it; the interval calls the same thing. */
    reconcileOnce(): Promise<void>
    /**
     * The poll path: the whole fleet's current states, each acknowledged as delivered. This is what
     * `GET /bots` answers with (Task 14) and the ONLY way the ledger drains in HTTP polling mode.
     * The returned states carry no `seq`, because a poll consumes no counter (`data.ts:676`).
     */
    serve(): ServedState[]
}

export type RosterSelection = {
    /** Every non-retired bot id, for messages that talk about the fleet as a whole. */
    active: string[]
    /** The bots that will actually be driven: non-retired, capped at `max_bots`, in roster order. */
    serve: Array<{ botId: string; fleetSerial: string | null }>
    /** Bots of `serve` with no mapping while the fleet requires one. Empty when it does not. */
    unmapped: string[]
}

/**
 * WHO GETS DRIVEN, decided once and shared. `efk start` and `efk check` used to work this out
 * separately and disagreed in both directions: the preflight built drivers for retired bots (two
 * rows may legitimately share a serial once one is retired, so it invented duplicate-serial
 * failures) and ignored `requires_fleet_serial` (so it passed for a roster the start parks).
 *
 * The cap is applied BEFORE the mapping gate on purpose: a bot beyond `max_bots` is never driven,
 * so an unmapped row down there must not park the fleet. A review reproduced exactly that — 49 good
 * bots plus one unmapped row past the cap, and the whole fleet went idle.
 */
export function selectRoster(
    roster: Array<{ bot_id: string; fleet_serial?: string | null; blocked_by: string[] }>,
    opts: { requiresFleetSerial: boolean; maxBots: number },
): RosterSelection {
    const active = roster.filter((b) => !b.blocked_by.includes('retired'))
    const serve = active.slice(0, opts.maxBots).map((b) => ({ botId: b.bot_id, fleetSerial: b.fleet_serial ?? null }))
    return {
        active: active.map((b) => b.bot_id),
        serve,
        unmapped: opts.requiresFleetSerial ? serve.filter((b) => !b.fleetSerial).map((b) => b.botId) : [],
    }
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
    const rosterRefreshMs = deps.rosterRefreshMs ?? ROSTER_REFRESH_MS
    /** The `fleet_serial` each live runtime was BUILT with, which is what a remap has to be compared against. */
    const bound = new Map<string, string | null>()
    let refreshTimer: ReturnType<typeof setInterval> | null = null
    /** The reconciliation running right now, so `stop()` can await it before tearing the fleet down. */
    let reconciling: Promise<void> | null = null
    /** The capabilities document remi last accepted, so an unchanged one is not sent every pass. */
    let sentCapabilities = ''

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
     * One bot's driver, ledger and runtime, built exactly the same way whether the bot arrives at
     * `start()` or shows up in a later roster. Two builders would drift, and the drift would read as
     * "a bot added without a restart behaves subtly unlike the same bot after one".
     *
     * `deps.driverFor` may THROW — a factory may refuse two bots that resolve to one robot,
     * and that refusal is the point. `start()` lets it out (a fleet that cannot be built must not
     * come up); `reconcile` catches it per bot and keeps the rest of the fleet driving.
     */
    const makeRuntime = (
        botId: string,
        fleetSerial: string | null,
    ): { ok: true; runtime: BotRuntime; driver: RobotDriver } | { ok: false; detail: string } => {
        const driver = deps.driverFor(botId, fleetSerial)
        if (driver.driverVersion !== 1)
            return { ok: false, detail: `driver for ${botId} implements version ${String(driver.driverVersion)}, the kit needs 1` }
        return {
            ok: true,
            driver,
            runtime: createBotRuntime({
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
        }
    }

    /**
     * Register the capabilities document, but only when it says something new.
     *
     * NEVER SENDS AN EMPTY ONE. With no runtimes `buildCapabilities()` falls back to
     * `{has_door: false, supported_commands: []}` — a document that tells remi these robots have no
     * door. remi then drops every `set_door`, open included, and turns `manual_close_door` on for
     * every bot of the fleet; that flag is one-way, so it stays on after a good document arrives and
     * has to be cleared by hand, bot by bot. Keeping the document remi already has is strictly
     * better, so an idle fleet registers nothing and leaves the previous one standing.
     */
    const sendCapabilities = async (): Promise<void> => {
        if (runtimes.length === 0) return
        const doc = buildCapabilities()
        const key = JSON.stringify(doc)
        if (key === sentCapabilities) return
        // A failure here must not stop the fleet: a fleet with no capabilities document on file
        // still runs on remi's default behaviour, and refusing to start would be a worse outcome
        // than starting without it.
        const sent = await deps.remi.setCapabilities(doc)
        if (!sent.ok) {
            deps.bus.emit('log', {
                level: 'error',
                message: `sending capabilities to remi failed: ${sent.status} ${sent.code}: ${sent.message}; the fleet is running anyway on remi's default behaviour`,
            })
            return
        }
        sentCapabilities = key
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

    /** Running a command right now. A terminal status parked in the slot is not busy — see CommandLedger. */
    const busy = (runtime: BotRuntime): boolean => {
        const status = runtime.currentCommand()
        return status !== null && (status.state === 'accepted' || status.state === 'executing')
    }

    /**
     * Follow remi's roster: add what appeared, drop what left, rebind what was remapped, leave
     * everything else untouched. The two rules that make it safe are at the top of the file.
     *
     * Every failure mode here ends the same way — keep driving the roster we have and say so. A
     * refresh is an improvement on the current picture, never a reason to lose it: remi being
     * briefly unreachable must not stop 50 robots that are mid-delivery.
     */
    const reconcile = async (): Promise<void> => {
        // `transport` doubles as the "started, not stopped" flag, and it is re-checked after every
        // await below: `stop()` can land in any of those gaps, and a pass that began before it must
        // not put the fleet back up behind its back.
        if (!transport) return
        // The credentials do not hot-reload (`resolve()` reads the env once, by design), so a fleet
        // that came up unable to build drivers stays that way until the process restarts. Re-reading
        // the roster would only build a list of bots nothing can drive.
        if (deps.driverUnavailable?.()) return
        const fleet = await deps.remi.getFleetConfig()
        if (!transport) return
        if (!fleet.ok) {
            deps.bus.emit('log', {
                level: 'warn',
                message: `roster refresh skipped: GET /api/v3/fleet → ${fleet.status} ${fleet.code}: ${fleet.message}. Still driving the roster already loaded.`,
            })
            return
        }
        if (fleet.data.transport !== deps.env.transport) {
            deps.bus.emit('log', {
                level: 'warn',
                message: `roster refresh skipped: remi now expects transport ${fleet.data.transport} and this process speaks ${deps.env.transport}. Restart it with the matching .env.`,
            })
            return
        }
        const roster = await deps.remi.listFleetBots()
        if (!transport) return
        if (!roster.ok) {
            deps.bus.emit('log', {
                level: 'warn',
                message: `roster refresh skipped: GET /api/v3/fleet/bots → ${roster.status} ${roster.code}: ${roster.message}. Still driving the roster already loaded.`,
            })
            return
        }
        config = fleet.data
        const selection = selectRoster(roster.data, {
            requiresFleetSerial: fleet.data.requires_fleet_serial ?? false,
            maxBots: fleet.data.max_bots,
        })
        // A REFRESH NEVER PARKS THE FLEET: an unmapped bot is skipped, not a reason to take the
        // robots that ARE mapped off the road. At `start()` the same condition parks everything,
        // and that asymmetry is deliberate — see the header.
        const unmapped = new Set(selection.unmapped)
        const wanted = new Map(selection.serve.filter((b) => !unmapped.has(b.botId)).map((b) => [b.botId, b.fleetSerial]))
        const live = new Set(runtimes.map((r) => r.botId))

        const drop: BotRuntime[] = []
        const add: Array<{ botId: string; fleetSerial: string | null }> = []
        const deferred: string[] = []
        for (const runtime of runtimes) {
            const botId = runtime.botId
            const stillWanted = wanted.has(botId)
            const rebound = stillWanted && (wanted.get(botId) ?? null) !== (bound.get(botId) ?? null)
            if (stillWanted && !rebound) continue
            if (busy(runtime)) {
                deferred.push(botId)
                continue
            }
            drop.push(runtime)
            if (rebound) add.push({ botId, fleetSerial: wanted.get(botId) ?? null })
        }
        for (const [botId, fleetSerial] of wanted) if (!live.has(botId)) add.push({ botId, fleetSerial })

        if (deferred.length > 0)
            deps.bus.emit('log', {
                level: 'warn',
                message: `roster change deferred for ${deferred.join(', ')}: still running a command. Rebuilding would drop the mission in flight; retrying on the next pass.`,
            })
        if (drop.length === 0 && add.length === 0) return

        // Let a tick that is already walking `runtimes` finish before the fleet changes underneath
        // it, exactly as `stop()` does — same reason, same await.
        await inFlight?.catch(() => {})
        if (!transport) return

        const dropped = new Set(drop.map((r) => r.botId))
        for (const runtime of drop) {
            // BEFORE building anything below: a retired bot's replacement legitimately inherits its
            // serial (remi's unique index is partial), and the driver factory will refuse the
            // handover while the outgoing driver still holds the claim.
            await runtime.stop()
            drivers.delete(runtime.botId)
            bound.delete(runtime.botId)
        }
        const next = runtimes.filter((r) => !dropped.has(r.botId))
        const added: string[] = []
        for (const { botId, fleetSerial } of add) {
            try {
                const built = makeRuntime(botId, fleetSerial)
                if (!built.ok) {
                    deps.bus.emit('log', { level: 'error', botId, message: `not driving ${botId}: ${built.detail}` })
                    continue
                }
                await built.runtime.start()
                drivers.set(botId, built.driver)
                bound.set(botId, fleetSerial)
                next.push(built.runtime)
                added.push(botId)
            } catch (error) {
                // One bot that cannot be built is one bot not driven, said out loud. The rest of the
                // fleet keeps going: this is the path a bad `fleet_serial` mapping arrives through.
                deps.bus.emit('log', { level: 'error', botId, message: `not driving ${botId}: ${describeThrown(error)}` })
            }
        }
        runtimes = next
        await transport.setBots(runtimes)
        await sendCapabilities()
        const removed = [...dropped].filter((id) => !added.includes(id))
        deps.bus.emit('log', {
            level: 'info',
            message: `roster refreshed${added.length > 0 ? `, now driving ${added.join(', ')}` : ''}${removed.length > 0 ? `, stopped driving ${removed.join(', ')}` : ''} (${runtimes.length} bot(s) in the fleet)`,
        })
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
            const selection = selectRoster(roster.data, {
                requiresFleetSerial: fleet.data.requires_fleet_serial ?? false,
                maxBots: fleet.data.max_bots,
            })
            const registered = selection.active
            // remi's id → the fleet's own id for the same robot, for the drivers built below. Kept in
            // `bound` afterwards, because a remap is only visible as a difference against what each
            // driver was actually built with — `reconcile` compares the two on every pass.
            const fleetSerials = new Map(selection.serve.map((b) => [b.botId, b.fleetSerial]))
            /**
             * IDLE, NOT A FAILURE — ONE state, reached two ways. The fleet comes up with no runtimes:
             * it serves an empty `GET /bots`, publishes nothing, and sends NO capabilities document
             * (see `sendCapabilities`), so remi keeps the one it has. Both used to abort the start,
             * which made a deployment impossible to verify until everything it was waiting for was
             * already in place.
             *
             * THE DRIVER OUTRANKS THE ROSTER, and that order is the whole point. Bots are registered
             * in remi by hand, on whatever day the onboarding happens; a partner's own API
             * credentials arrive when the partner sends them. The normal case is therefore a FULL
             * roster with NO credentials — building a driver per bot there would throw once per
             * robot for a state that is simply "not ready yet".
             *
             * Of the three idle reasons, only the credentials one still needs a restart: the roster
             * is re-read every `ROSTER_REFRESH_MS`, so an empty roster and an unmapped bot both
             * resolve themselves the moment remi holds the right rows (`reconcile`). The env does
             * not hot-reload, so missing credentials do not.
             */
            /**
             * A MAPPED FLEET WITH AN UNMAPPED BOT IS IDLE, NOT PARTIALLY DRIVEN. When remi says the
             * ids of this fleet are internal (`requires_fleet_serial`), a bot without `fleet_serial`
             * has no serial at all: stripping the prefix off `ACME-0173` yields `0173`, which addresses
             * either nothing or somebody else's robot. remi refuses such a registration, so reaching
             * here means the row predates the flag — a data problem a person has to fix.
             *
             * Parking the WHOLE fleet rather than skipping the offending bots is deliberate: 49 of 50
             * robots working is the kind of partial success nobody notices until an order is stuck on
             * the one that is missing.
             */
            const unmapped = selection.unmapped
            const unavailable = deps.driverUnavailable?.() ?? null
            const idle = unavailable
                ? `${unavailable}, so no robot can be driven — ${registered.length} bot(s) are registered and waiting`
                : unmapped.length > 0
                  ? `this fleet requires fleet_serial and ${unmapped.length} bot(s) have none: ${unmapped.join(', ')}. Their serial cannot be derived from the id, so no robot is driven until remi holds a mapping for every bot`
                  : registered.length === 0
                    ? 'no bots are registered against this fleet yet (GET /api/v3/fleet/bots returned 0)'
                    : null
            if (idle)
                deps.bus.emit('log', {
                    level: 'warn',
                    message: `idle: ${idle}. The fleet manager is up and registered with remi, and will publish nothing until this is resolved.${
                        unavailable
                            ? ' Fix it, then restart this process.'
                            : ` Fix it in remi and this process picks it up within ${Math.round(rosterRefreshMs / 1000)}s.`
                    }`,
                })
            const ids = idle ? [] : selection.serve.map((b) => b.botId)
            if (!idle && registered.length > ids.length) {
                deps.bus.emit('log', {
                    level: 'warn',
                    message: `roster has ${registered.length} bots but max_bots is ${fleet.data.max_bots}; serving the first ${ids.length}`,
                })
            }
            // NOTHING below is written to the manager's own state until the whole fleet has been
            // built. A `start()` that answers `ok: false` must leave the manager exactly as it found
            // it: `runtimes.push` appends, so a CLI retrying a transient failure would otherwise be
            // handed a SECOND fleet stacked on the half-built first one, and `bots()` would report a
            // fleet for a start that failed.
            const built: BotRuntime[] = []
            const builtDrivers = new Map<string, RobotDriver>()
            // No second `.slice`: `selectRoster` already applied the cap, and applying it twice is
            // how the gate and the driver loop came to disagree about who is actually driven.
            for (const botId of ids) {
                const one = makeRuntime(botId, fleetSerials.get(botId) ?? null)
                if (!one.ok) return { ok: false, reason: 'driver_version', detail: one.detail }
                builtDrivers.set(botId, one.driver)
                built.push(one.runtime)
            }

            // The commit point: from here the start can no longer answer `ok: false`. The fleet has
            // to be visible BEFORE `transport.start()` subscribes — a broker that has a command
            // waiting delivers it the moment we subscribe, and an empty `runtimes` would answer that
            // command with `unknown bot`. `config()` is published here too, so it describes a fleet
            // that exists rather than a start that failed.
            runtimes = built
            for (const [botId, driver] of builtDrivers) drivers.set(botId, driver)
            for (const botId of ids) bound.set(botId, fleetSerials.get(botId) ?? null)
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
            await sendCapabilities()
            // The roster loop runs even for a fleet that came up idle with an empty roster — that is
            // the case it earns its keep on: the bots are registered later, from remi's own UI, and
            // this process picks them up without anybody logging into the cluster.
            if (rosterRefreshMs > 0)
                refreshTimer = setInterval(() => {
                    // One pass at a time. A slow remi must queue nothing up: the next pass reads the
                    // roster again anyway, so a skipped tick loses no information.
                    if (reconciling) return
                    const run = reconcile().catch((error: unknown) => {
                        deps.bus.emit('log', { level: 'error', message: `roster refresh failed: ${describeThrown(error)}` })
                    })
                    reconciling = run
                    const clear = () => {
                        if (reconciling === run) reconciling = null
                    }
                    run.then(clear, clear)
                }, rosterRefreshMs)
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
            if (refreshTimer) clearInterval(refreshTimer)
            refreshTimer = null
            // A reconciliation in flight is building and starting runtimes; letting it finish here is
            // what stops it putting the fleet back up behind the shutdown's back. The timer is
            // already cleared, so no further pass can start, and `reconcile` re-checks `transport`
            // after each of its own awaits for the gap this one cannot cover.
            await reconciling?.catch(() => {})
            reconciling = null
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
            bound.clear()
            sentCapabilities = ''
            transport = null
        },
        bots: () => runtimes,
        driver: (botId) => drivers.get(botId),
        config: () => config,
        capabilities: buildCapabilities,
        tickOnce: tick,
        reconcileOnce: reconcile,
        serve,
    }
}
