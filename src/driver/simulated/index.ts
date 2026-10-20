/**
 * SimulatedRobotDriver: N fake bots that behave like robots against the contract (design §6). It only
 * produces DriverSnapshot and driver events; it knows no topic, no HTTP status, no BotState.
 * Movement is bot-sim's stepper on two-point routes; door, battery, link and destinations are the
 * modules next to this file. Every fault is a scenario field, not a code path.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DestinationValidation } from '../../contract/schemas'
import type { DriverContext, DriverEvents, DriverFactory, DriverSnapshot, Position, RobotDriver } from '../robot-driver'
import { type Battery, createBattery } from './battery'
import { createDestinations, type Destinations } from './destinations'
import { createDoor, type Door } from './door'
import { createLink, type Link } from './link'
import { initialNoiseState, type NoiseState, offsetBy, stepRoute, straightRoute, type WalkableRoute } from './motion'
import { type BotScenario, botScenarioFor, overrideIdsNotIn, parseScenario, type Scenario } from './scenario'

export type SimulatedDriverOptions = {
    botId: string
    scenario: BotScenario
    /** Fleet origin (SANDBOX_CENTER_* or scenario.fleet.origin). Destinations are measured from here. */
    origin: Position
    scatterRadiusM: number
    now: () => number
    random: () => number
}

export interface SimulatedRobotDriver extends RobotDriver {
    /** Advance the simulation. Called by the fleet tick (250 ms) or by tests. */
    tick(nowMs: number): void
    /** Whether the MQTT transport should hold this bot's connection open right now. */
    wantsConnection(): boolean
    // TUI toggles
    setAvailable(value: boolean): void
    toggleDoorLocally(): void
    /** `true`/`false` force the link; `null` hands it back to the scenario (`link.mode`). */
    setOffline(value: boolean | null): void
    emitBlocked(reason: string, message?: string): void
    emitUnblocked(): void
}

type Navigation = {
    id: string
    route: WalkableRoute
    travelledM: number
    noise: NoiseState
    dwellUntil: number | null
    started: boolean
    stalledReported: boolean
}

export function createSimulatedDriver(options: SimulatedDriverOptions): SimulatedRobotDriver {
    const { botId, scenario, random } = options
    /**
     * ONE CLOCK, not two (controller ruling, Task 15). The driver used to read `options.now()` for
     * the door, the link and the battery while motion advanced on the `nowMs` handed to `tick()`:
     * two clocks that only the tests kept equal by hand, so a caller whose loop time drifted from
     * its `now` left the door living in a different time from the wheels — the door would finish
     * early, late, or (with a frozen `now`) never. `tick()` is the authoritative time source once
     * the simulation is running; `options.now()` only answers before the first tick, which is all
     * that construction and `start()` need.
     */
    let tickNowMs: number | null = null
    const now = () => tickNowMs ?? options.now()
    const handlers = new Map<keyof DriverEvents, Set<(...args: never[]) => void>>()
    const emit = <K extends keyof DriverEvents>(event: K, ...args: Parameters<DriverEvents[K]>) => {
        for (const handler of handlers.get(event) ?? []) (handler as (...a: Parameters<DriverEvents[K]>) => void)(...args)
    }
    /**
     * `ackGoals: false` is the LOST ECHO fault, and it is specific to navigation: the bot drives but
     * never reports the goal, so remi resends the same `navigate_to` id. It must not silence the
     * whole driver — a fleet where `cancel_navigation` and `set_door` also stopped answering is not
     * the failure this knob reproduces, and it makes the scenario useless for testing a delivery
     * (the door step would hang too, for the wrong reason).
     */
    const ackNav = <K extends 'commandState' | 'arrived'>(event: K, ...args: Parameters<DriverEvents[K]>) => {
        if (scenario.motion.ackGoals) emit(event, ...args)
    }

    // Scatter the bot around the origin, sqrt-distributed so a fleet does not clump in the middle.
    const bearing = random() * 360
    const radius = Math.sqrt(random()) * options.scatterRadiusM
    let position: Position = radius > 0 ? offsetBy(options.origin, radius, bearing) : options.origin
    let speedMps = 0
    let nav: Navigation | null = null
    let lastTickMs: number | null = null
    let availableOverride: boolean | null = null
    let offlineOverride: boolean | null = null
    // All mutable state is declared HERE, with the rest. A `let` referenced by the returned object
    // but written after the `return` statement is not hoisted into a usable binding — it is a
    // ReferenceError at runtime and an error at typecheck.
    let pendingCancel: string | null = null
    let pendingDoor: string | null = null
    let lastConnected = true

    const door: Door = createDoor(scenario.door, now)
    const battery: Battery = createBattery(scenario.battery)
    let link: Link = createLink(scenario.link, now())
    const destinations: Destinations = createDestinations(scenario.destinations, options.origin)

    const connected = () => (offlineOverride === null ? link.shouldBeConnected(now()) : !offlineOverride)
    const available = () => (availableOverride ?? scenario.available) && !battery.unavailable()

    const supported = (): Array<'navigate_to' | 'cancel_navigation' | 'set_door'> =>
        scenario.door.hasDoor ? ['navigate_to', 'cancel_navigation', 'set_door'] : ['navigate_to', 'cancel_navigation']

    return {
        botId,
        driverVersion: 1,
        async start(_ctx: DriverContext) {
            link = createLink(scenario.link, now())
            lastTickMs = now()
        },
        async stop() {},
        snapshot(): DriverSnapshot {
            return {
                position,
                batteryPercentage: battery.percentage(),
                speedMps,
                door: door.reported(),
                available: available(),
                connected: connected(),
            }
        },
        capabilities() {
            return { hasDoor: scenario.door.hasDoor, supportedCommands: supported() }
        },
        async navigateTo(cmd) {
            const resolution = destinations.resolve(cmd.target)
            if (resolution.kind === 'unreachable') {
                return {
                    kind: 'rejected',
                    code: 'DESTINATION_UNREACHABLE',
                    message: `${resolution.distanceM} m beyond the service area`,
                    correctionDistanceM: resolution.distanceM,
                }
            }
            const route = straightRoute(position, resolution.corrected) ?? { path: [position, position], cumulative: [0, 0], totalM: 0 }
            nav = { id: cmd.id, route, travelledM: 0, noise: initialNoiseState(), dwellUntil: null, started: false, stalledReported: false }
            // A correction is reported when the destination actually MOVED. The old check also fired
            // on `resolution.corrected !== cmd.target`, an identity comparison that is true whenever
            // snapping is on — even for a point already on the grid, which produced a correction of
            // 0 m on every command and a `corrected_position` remi would record for nothing.
            return resolution.distanceM > 0
                ? { kind: 'accepted_with_correction', position: resolution.corrected, distanceM: resolution.distanceM }
                : { kind: 'accepted' }
        },
        async cancelNavigation(cmd) {
            nav = null
            speedMps = 0
            // Reported as `succeeded` on the next tick, and nothing else: the kit already recorded the
            // cancel as `accepted` when the driver returned, and an `executing` in between would be a
            // transition the ledger refuses (accepted → executing → succeeded is fine, but the test
            // then has to assert two events for a command that took no time at all). One event, one
            // meaning: the robot has stopped.
            pendingCancel = cmd.id
            return { kind: 'accepted' }
        },
        async setDoor(cmd) {
            if (!scenario.door.hasDoor) return { kind: 'rejected', code: 'UNSUPPORTED_COMMAND', message: 'this bot has no door' }
            door.command(cmd.state)
            // `ignore` is the fault "the door never reacts", so nothing is ever pending and the
            // command hangs on purpose until remi's 25 s door timeout. Every other mode resolves on a
            // tick — INCLUDING the case where the lid is already where it was asked to be and
            // `command()` returned false: `set_door: closed` on a closed door is what remi sends at
            // the end of every delivery, and it must succeed, not hang.
            if (scenario.door.mode !== 'ignore') pendingDoor = cmd.id
            return { kind: 'accepted' }
        },
        validateDestination(target): Promise<DestinationValidation> {
            return Promise.resolve(destinations.validate(target))
        },
        on(event, handler) {
            const set = handlers.get(event) ?? new Set()
            set.add(handler as (...args: never[]) => void)
            handlers.set(event, set)
            return () => set.delete(handler as (...args: never[]) => void)
        },
        tick(nowMs) {
            // Before anything else: the tick's time becomes THE time, for door and link as well as
            // for the wheels. See the note on `now` above.
            tickNowMs = nowMs
            const dtMs = lastTickMs === null ? 0 : nowMs - lastTickMs
            lastTickMs = nowMs
            let travelled = 0

            if (pendingCancel) {
                // One event. `cancel_navigation` is not gated by ackGoals (see ackNav).
                emit('commandState', pendingCancel, 'succeeded')
                pendingCancel = null
            }

            if (nav) {
                if (!nav.started) {
                    nav.started = true
                    ackNav('commandState', nav.id, 'executing')
                }
                if (nav.dwellUntil !== null && nowMs < nav.dwellUntil) {
                    speedMps = 0
                } else {
                    nav.dwellUntil = null
                    const step = stepRoute({
                        route: nav.route,
                        travelledM: nav.travelledM,
                        speedMps: scenario.motion.speedMps,
                        dtMs,
                        noise: scenario.motion.noise,
                        noiseState: nav.noise,
                        arrive: scenario.motion.arrive,
                        random,
                    })
                    travelled = step.travelledM - nav.travelledM
                    nav.travelledM = step.travelledM
                    nav.noise = step.noiseState
                    position = step.coords
                    speedMps = step.speedMps
                    if (step.startDwellMs !== null) nav.dwellUntil = nowMs + step.startDwellMs
                    if (step.arrived) {
                        const id = nav.id
                        nav = null
                        speedMps = 0
                        ackNav('arrived', id)
                        ackNav('commandState', id, 'succeeded')
                    } else if (scenario.motion.arrive === 'stall' && travelled === 0 && nav.travelledM > 0 && !nav.stalledReported) {
                        nav.stalledReported = true
                        emit('blocked', { reason: 'stalled', message: 'gave up mid route' })
                    }
                }
            } else {
                speedMps = 0
            }

            battery.advance(travelled, dtMs, nav !== null)

            // The door is resolved on its REPORTED value, not on "did it change this tick": a
            // `set_door` that asked for the state the lid is already in changes nothing and would
            // otherwise never be answered.
            if (door.tick()) emit('stateChanged')
            if (pendingDoor) {
                const reported = door.reported()
                if (reported === 'stalled') {
                    emit('commandState', pendingDoor, 'failed', { code: 'DOOR_STALLED', message: 'door did not reach the target' })
                    pendingDoor = null
                } else if (!door.pending() && (reported === 'opened' || reported === 'closed')) {
                    emit('commandState', pendingDoor, 'succeeded')
                    pendingDoor = null
                }
                // Still moving: answer on a later tick. `boolean` mode reports `closed` throughout an
                // opening, which is exactly why `door.pending()` and not `reported` decides here.
            }

            const nowConnected = connected()
            if (nowConnected !== lastConnected) {
                lastConnected = nowConnected
                emit('stateChanged')
            }
        },
        wantsConnection: connected,
        setAvailable(value) {
            availableOverride = value
            emit('stateChanged')
        },
        toggleDoorLocally() {
            door.command(door.reported() === 'opened' || door.reported() === 'opening' ? 'closed' : 'open')
        },
        setOffline(value) {
            offlineOverride = value
            emit('stateChanged')
        },
        emitBlocked(reason, message = reason) {
            emit('blocked', { reason, message })
        },
        emitUnblocked() {
            emit('unblocked')
        },
    }
}

/**
 * Where the bundled scenarios live, resolved from THIS module, not from the working directory.
 * `resolve('scenarios', …)` is relative to `process.cwd()`, and `efk` is meant to be run from a
 * partner's own project: the kit would look for `./scenarios/default.json` inside their repo and
 * fail with a confusing ENOENT. The same reasoning applies to `efk scenarios list` (Task 16).
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export function scenarioPath(name: string): string {
    return join(PACKAGE_ROOT, 'scenarios', `${name}.json`)
}

export function listScenarios(): string[] {
    return readdirSync(join(PACKAGE_ROOT, 'scenarios'))
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.replace(/\.json$/, ''))
        .sort()
}

/**
 * One line per bundled scenario, for `efk scenarios list` (Task 16) and for the README.
 *
 * `no-interrupt` is the one that needs it (controller ruling R18). Parsed, that file is IDENTICAL to
 * `default.json`: the knob its name promises — `supports_command_interrupt` — is a FLEET capability
 * that lives in `efk.config.ts`, not a per-bot scenario field, so there is nothing for the JSON to
 * say. Without this note it is an inert duplicate of another scenario with no explanation, which is
 * exactly what a reader would flag. Anything printing a scenario name must print its note too.
 */
export const SCENARIO_NOTES: Readonly<Record<string, string>> = {
    default: 'A healthy fleet: bots drive, arrive, and answer every command.',
    'boolean-door': 'Doors report only opened/closed — no opening/closing transients, like a partner with a lid boolean.',
    'low-battery': 'ACME-0001..3 sit at 15/20/21 % and do not drain, to exercise the eligibility threshold on both sides of 20 %.',
    'never-arrives': 'Bots park one metre short of every destination and never confirm arrival.',
    'no-interrupt':
        'INERT as a scenario: it parses exactly like `default`. The knob it names, `supports_command_interrupt`, is a FLEET capability — set `fleet.supportsCommandInterrupt: false` in `efk.config.ts` and restart to see it. Declaring false makes the second navigate_to of a job be rejected with BOT_BUSY.',
    'offline-flapping': 'ACME-0001 is permanently offline and ACME-0002 flaps its link every 20 s; the rest stay connected.',
    'destination-correction': 'Destinations snap to a 0.0002° grid and anything beyond 300 m of the origin is rejected as unreachable.',
}

export type SimulatedFactoryOptions = {
    scenario: string | Scenario
    now?: () => number
    /** Fleet seed. The same seed and the same bot id always produce the same stream, run after run. */
    seed?: string
    /** Per-bot source of randomness. Default: mulberry32 seeded from `${seed}:${botId}` — see `seededRandom`. */
    randomFor?: (botId: string) => () => number
}

/**
 * ONE STREAM PER BOT, seeded from its id (controller ruling, Task 15). The factory used to hand the
 * SAME `random` function to every driver, which couples each bot's noise to every other bot's
 * command timing: the draws a bot makes per tick depend on its own STATE — `drift()` returns before
 * drawing when its bound is 0, the dwell draws happen only while the bot is progressing, and an idle
 * bot never calls `stepRoute` at all — so the same seed produced a different trace for a bot
 * depending on where it sat in the roster and on what the others happened to be doing. Sorting the
 * roster does not fix that; only a stream per bot does.
 *
 * mulberry32 over a 32-bit FNV-1a of the seed string: no dependency, and `random()` stays injected
 * everywhere (global constraint), just once per bot instead of once per fleet.
 */
function seededRandom(seed: string): () => number {
    let hash = 0x811c9dc5
    for (let i = 0; i < seed.length; i += 1) {
        hash = Math.imul(hash ^ seed.charCodeAt(i), 0x01000193) >>> 0
    }
    let state = hash >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/**
 * `driver: simulated({ scenario: 'default' })` in efk.config.ts. `scenario` is a name under
 * scenarios/ or an already parsed object. The origin comes from the scenario or from the .env
 * (SANDBOX_CENTER_*), which the CLI passes in as `env.origin`.
 *
 * `auditRoster` is why the factory is not a bare arrow function. The bundled scenarios use the Acme
 * cast (`ACME-0001`…), which is almost certainly NOT a partner's roster, and an override keyed on a
 * bot that does not exist does exactly nothing: `--scenario low-battery` against a real fleet would
 * look like a kit that ignores its own scenarios. The audit needs the WHOLE roster, so it cannot run
 * inside the per-bot factory call — `efk start` calls it once after the roster is known, and C9
 * reports the same list.
 *
 * `DriverFactory` is imported from `robot-driver.ts`, where it is declared once (controller ruling
 * R12): the CLI config loader needs the same type, and re-declaring it here would let the two drift.
 * It is parameterised with `SimulatedRobotDriver` so the CLI gets `tick()` and the TUI gets the
 * toggles without a cast, while still assigning to a bare `DriverFactory` wherever the kit only
 * wants a `RobotDriver`.
 *
 * Each bot gets its OWN stream of randomness, seeded from its id — see `seededRandom`.
 */
export function simulated(options: SimulatedFactoryOptions): DriverFactory<SimulatedRobotDriver> {
    const scenario =
        typeof options.scenario === 'string'
            ? parseScenario(JSON.parse(readFileSync(scenarioPath(options.scenario), 'utf8')))
            : options.scenario
    const seed = options.seed ?? 'efk'
    const randomFor = options.randomFor ?? ((botId: string) => seededRandom(`${seed}:${botId}`))
    const factory: DriverFactory<SimulatedRobotDriver> = (botId, env) => {
        // `env.origin` is optional now (the SANDBOX_* are), and THIS driver is the one that cannot do
        // without it: it spawns bots around that point and measures every destination from it. Said
        // here, when the bot is built, rather than by the kit refusing to start — a real driver never
        // reads it, so a missing origin is only an error for the drivers that do.
        const origin = scenario.fleet.origin ?? env.origin
        if (!origin)
            throw new Error(
                'the simulated driver needs a fleet origin: set SANDBOX_CENTER_LAT and SANDBOX_CENTER_LNG in the .env, or give the scenario its own fleet.origin',
            )
        return createSimulatedDriver({
            botId,
            scenario: botScenarioFor(scenario, botId),
            origin,
            scatterRadiusM: scenario.fleet.scatterRadiusM,
            now: options.now ?? Date.now,
            random: randomFor(botId),
        })
    }
    factory.auditRoster = (roster) => overrideIdsNotIn(scenario, roster)
    return factory
}
