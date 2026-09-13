/**
 * `efk start`: lock → env → config → remi → fleet manager → transport → TUI/web. Refuses to start on
 * a second instance, an unparseable .env, a transport mismatch or an empty roster, each with the
 * message the design lists (§9.6).
 *
 * There is exactly ONE way out (`shutdown`), used by SIGINT, SIGTERM and the TUI's `q`. An earlier
 * draft had the TUI raise a synthetic SIGINT to reuse the signal path; that is a process-wide side
 * effect fired from a UI component, and it fights with anything else the process installs.
 *
 * `startWith` is the seam. Everything environmental — the clock's neighbours: the lock file, the
 * state file, the .env, efk.config.ts, the TUI, the dashboard, the fleet manager, `efk check` and
 * its delay — arrives as a dependency, and `start()` is the one-line caller that supplies the real
 * ones. Without it `start.test.ts` could not exist: the demo banner, the `--check` wiring and the
 * idempotence of shutdown are all properties of THIS function, and testing them by launching the
 * real CLI would mean a real lock file, a real .env and a real 10 s wait.
 */
import { resolve } from 'node:path'
import { loadConfig } from '../config'
import { TICK_MS } from '../core/cadence'
import { createEventBus } from '../core/events'
import { createFakeRemiClient } from '../core/fake-remi'
import { createFleetManager } from '../core/fleet-manager'
import { createSeq } from '../core/seq'
import { createStateStore } from '../core/state-store'
import type { RobotDriver } from '../driver/robot-driver'
import { listScenarios } from '../driver/simulated'
import { createLogger } from '../log'
import { createRemiClient } from '../remi/client'
import { createHttpTransport } from '../transport/http'
import { createMqttTransport } from '../transport/mqtt'
import { startTui } from '../tui'
import { startWeb } from '../web'
import { formatReport, runCheck } from './check'
import { loadEnv } from './env'
import { acquireLock, processIsAlive } from './lock'
import { httpProbe, mqttProbe, parityProbe } from './probes'

export type StartOptions = { scenario?: string; web: boolean; webHost: string; headless: boolean; check: boolean; demo: boolean }

/** Everything `startWith` needs from outside itself. `start()` supplies the real implementations. */
export type StartDeps = {
    createEventBus: typeof createEventBus
    startTui: typeof startTui
    startWeb: typeof startWeb
    createFleetManager: typeof createFleetManager
    loadEnv: typeof loadEnv
    loadConfig: typeof loadConfig
    acquireLock: typeof acquireLock
    createStateStore: typeof createStateStore
    runCheck: typeof runCheck
    listScenarios: typeof listScenarios
    lockPath: string
    statePath: string
    /** How long `--check` waits for the fleet to settle before running the conformance pass. */
    checkDelayMs: number
}

export const DEMO_BANNER = 'DEMO MODE — not connected to remi. Every roster, bot and delivery you see here is invented by the kit.'

/**
 * A driver that steps its own simulation. The bundled simulator does (`SimulatedRobotDriver.tick`);
 * a partner's real driver does not, because a real robot moves whether or not anybody calls it.
 *
 * It is a RUNTIME guard and not a cast, because the type is genuinely gone by this point:
 * `DriverFactory` is generic in the driver it builds (ruling R12) and `simulated()` declares itself
 * `DriverFactory<SimulatedRobotDriver>`, but `KitConfig.driver` is the bare `DriverFactory`, so
 * whatever `efk.config.ts` exports arrives here as a plain `RobotDriver`. Asserting the narrow type
 * would call `tick` on a partner's driver that has no such method.
 */
type SteppedDriver = RobotDriver & { tick(nowMs: number): void }
const isStepped = (driver: RobotDriver | undefined): driver is SteppedDriver =>
    typeof (driver as SteppedDriver | undefined)?.tick === 'function'

export function start(options: StartOptions): Promise<number> {
    return startWith(options, {
        createEventBus,
        startTui,
        startWeb,
        createFleetManager,
        loadEnv,
        loadConfig,
        acquireLock,
        createStateStore,
        runCheck,
        listScenarios,
        lockPath: resolve('.efk.lock'),
        statePath: resolve('.efk-state.json'),
        checkDelayMs: 10_000,
    })
}

export async function startWith(options: StartOptions, deps: StartDeps): Promise<number> {
    /**
     * Validated BEFORE the lock, because a typo should not create and delete a lock file, and above
     * all before the name reaches `EFK_SCENARIO`. `scenarioPath()` does no validation at all: it
     * joins the name into `scenarios/<name>.json`, so `--scenario ../../../etc/something` would read
     * an arbitrary JSON file off the partner's disk and try to parse it as a scenario. The known list
     * is the whole grammar this flag has.
     */
    if (options.scenario !== undefined) {
        const known = deps.listScenarios()
        if (!known.includes(options.scenario)) {
            console.error(
                `unknown scenario '${options.scenario}'. The bundled ones are: ${known.join(', ')} — run \`efk scenarios list\` to see what each one does.`,
            )
            return 1
        }
    }

    const lock = deps.acquireLock(deps.lockPath, { pid: process.pid, now: Date.now, isAlive: processIsAlive })
    if ('held' in lock) {
        console.error(`Another efk is running (pid ${lock.held.pid}); two instances would publish conflicting seq.`)
        return 1
    }
    if ('contended' in lock) {
        // The third outcome, and the reason `acquireLock` has one: we lost the race for a lock whose
        // file we could not read, so there is no holder to name. The old shape invented `pid -1` and
        // the current time, which printed at a partner as "already running (pid -1) since just now".
        console.error(
            `Another efk took ${deps.lockPath} first; two instances would publish conflicting seq. The lock file does not say which process holds it — stop the other efk, or delete the file if you are certain nothing is running.`,
        )
        return 1
    }
    try {
        const env = deps.loadEnv()
        if (!env.ok) {
            console.error(`.env does not parse: ${env.error}\nCopy the .env Robot.com sent you (see efk check).`)
            return 1
        }
        if (options.scenario) process.env.EFK_SCENARIO = options.scenario
        const config = await deps.loadConfig()
        if (!config.ok) {
            console.error(`efk.config.ts: ${config.error}`)
            return 1
        }
        const bus = deps.createEventBus()
        const log = createLogger(env.env.LOG_LEVEL, bus, {
            // With the TUI mounted nothing may reach stdout/stderr: it would tear the screen. The bus
            // is then the only sink, and the LOG section is where the lines show up.
            sink: options.headless ? 'stderr' : 'bus',
            // Empty strings are filtered out: an empty needle matches at every position, so a
            // redactor handed one would either rewrite every line or (worse) look like it was
            // redacting when it was not. MQTT_PASSWORD is legitimately empty until the partner
            // pastes it (see the .env schema), so this is the normal case, not a corner one.
            secrets: [env.env.REMI_API_KEY, env.env.MQTT_PASSWORD ?? '', env.env.HTTP_TOKEN ?? ''].filter((s) => s.length > 0),
        })

        const demo = options.demo || process.env.EFK_FAKE_REMI === '1'
        if (demo) {
            // Loud, repeatedly, everywhere: the banner, the log, and `efk check` C2 as a FAIL. This
            // mode exists so someone can look at the TUI and the dashboard with no credentials; the
            // one thing it must never do is let a partner believe they are talking to remi.
            console.warn(DEMO_BANNER)
            log.warn(DEMO_BANNER)
        }
        const remi = demo
            ? createFakeRemiClient({ transport: env.env.REMI_TRANSPORT })
            : createRemiClient({ baseUrl: env.env.REMI_API_URL, apiKey: env.env.REMI_API_KEY })

        const origin = { lat: env.env.SANDBOX_CENTER_LAT, lng: env.env.SANDBOX_CENTER_LNG }
        /**
         * THE DISCARD HAS TO BE HEARD. `createStateStore` reports through `onDiscard` when
         * `.efk-state.json` is unreadable and the per-bot `seq` counters restart at 1 — and until
         * this line nothing anywhere listened to it. remi silently discards any state whose `seq` is
         * below the last one it stored, and a bot a week into a run at 4 Hz sits near 2.4 million, so
         * a silent reset means remi rejects that bot for DAYS with nothing to see.
         *
         * It is passed to `createStateStore` itself and not attached afterwards: `createSeq` calls
         * `store.read()` during its own construction, so by the time this expression has finished
         * evaluating the discard has already happened. A handler registered on the next line would
         * be a handler for an event that already fired.
         *
         * The bus is the canonical route, at warn level, because that is how the whole core reports.
         * In `--headless` the logger is already the bus's observer (see `createLogger`), so that one
         * emit reaches stderr and nothing more is needed. With the TUI, nothing observes the bus
         * until it mounts — several lines below — so a line that only went to the bus would be
         * emitted into an empty room, and this is the one line whose whole purpose is to be seen;
         * the screen has not been taken yet, so `console.warn` is still safe there. Exactly one
         * line in each mode, and none lost.
         */
        const announceDiscard = (reason: string) => {
            bus.emit('log', { level: 'warn', message: reason })
            if (!options.headless) console.warn(reason)
        }
        const seq = createSeq(deps.createStateStore(deps.statePath, { onDiscard: announceDiscard }))
        const manager = deps.createFleetManager({
            remi,
            // The namespace comes from GET /api/v3/fleet, which only the manager has read by the time
            // the transport is built — hence the config as the second argument (Task 8).
            transportFor: (kind, fleetConfig) =>
                kind === 'mqtt'
                    ? createMqttTransport({
                          namespace: fleetConfig.namespace,
                          url: `mqtts://${env.env.MQTT_HOST}:${env.env.MQTT_PORT}`,
                          username: env.env.MQTT_USERNAME ?? '',
                          password: env.env.MQTT_PASSWORD ?? '',
                          bus,
                          now: Date.now,
                      })
                    : createHttpTransport({
                          port: env.env.HTTP_PORT,
                          token: env.env.HTTP_TOKEN ?? '',
                          bus,
                          push: env.env.HTTP_PUSH,
                          // `manager.serve()`, never a hand-rolled assembly from `bots()`: in HTTP
                          // polling mode — the default — the poll IS the delivery, and this is the
                          // ONLY path that drains the command ledger. The closure is what breaks the
                          // cycle, since the manager builds its transport inside its own `start()`.
                          serveFleet: () => manager.serve(),
                          remi,
                      }),
            driverFor: (botId) => config.config.driver(botId, { origin }),
            fleet: config.config.fleet,
            env: { transport: env.env.REMI_TRANSPORT },
            bus,
            seq,
            now: Date.now,
        })
        const started = await manager.start()
        if (!started.ok) {
            console.error(started.detail)
            return 1
        }
        log.info({ roster: started.roster }, 'fleet started')

        // A scenario override keyed on a bot that is not in the roster does nothing, and looks like a
        // kit that ignores its own scenarios. Now that the roster is known, say so.
        const strays = config.config.driver.auditRoster?.(started.roster) ?? []
        if (strays.length > 0)
            log.warn({ strays }, 'scenario overrides name bots that are not in your roster; edit the ids in the scenario to match yours')

        const stops: Array<() => Promise<void> | void> = [() => manager.stop()]
        let checkTimer: ReturnType<typeof setTimeout> | null = null
        let exiting = false
        let finished = false
        let finish: (() => void) | null = null

        const shutdown = async () => {
            if (exiting) return
            exiting = true
            if (checkTimer) clearTimeout(checkTimer)
            // Reverse order, on a COPY: `Array.prototype.reverse` mutates, and a second call (SIGINT
            // twice, or `q` followed by Ctrl+C) would then tear things down in the original order.
            for (const stop of [...stops].reverse()) await stop()
            // Set BEFORE `finish?.()` and checked by the waiter below: a shutdown that arrives while
            // the dashboard or the TUI is still mounting would otherwise find `finish` still null,
            // resolve nothing, and leave `efk start` awaiting a promise no one can settle again.
            finished = true
            finish?.()
        }

        /**
         * Everything registered from here on is registered ATOMICALLY with respect to `shutdown`: if
         * the signal arrived while we were awaiting the thing we are about to register, `stops` has
         * already been walked and appending to it now would leave that resource running for ever —
         * a listening dashboard is an open handle, so the process would not even exit.
         */
        const register = async (stop: () => Promise<void> | void): Promise<void> => {
            if (exiting) await stop()
            else stops.push(stop)
        }

        // Installed BEFORE the dashboard and the TUI, not after: a Ctrl+C while the dashboard is
        // binding its port has to run this shutdown — and release the lock — rather than kill the
        // process through the default handler.
        const onSignal = () => void shutdown()
        process.once('SIGINT', onSignal)
        process.once('SIGTERM', onSignal)
        try {
            /**
             * The simulator advances on a clock somebody has to turn: the fleet tick ASKS a driver
             * what it sees, it does not move it. A real robot moves on its own and exposes no
             * `tick`, so this steps only the drivers that have one, on the same 250 ms cadence the
             * manager publishes at.
             */
            const stepped = started.roster.map((botId) => manager.driver(botId)).filter(isStepped)
            if (stepped.length > 0) {
                const simTimer = setInterval(() => {
                    const nowMs = Date.now()
                    for (const driver of stepped) driver.tick(nowMs)
                }, TICK_MS)
                await register(() => clearInterval(simTimer))
            }

            if (options.web) await register(await deps.startWeb({ bus, manager, host: options.webHost, port: env.env.WEB_PORT, demo }))
            if (!options.headless)
                await register(await deps.startTui({ bus, manager, roster: started.roster, demo, onQuit: () => void shutdown() }))
            if (options.check && !exiting) {
                checkTimer = setTimeout(() => {
                    void (async () => {
                        try {
                            const report = await deps.runCheck({
                                env: env.env,
                                remi,
                                config: config.config,
                                mqttProbe,
                                httpProbe,
                                parity: parityProbe,
                                demo,
                                now: Date.now,
                                random: Math.random,
                            })
                            bus.emit('log', { level: report.exitCode === 0 ? 'info' : 'warn', message: `\n${formatReport(report)}` })
                        } catch (error) {
                            bus.emit('log', { level: 'error', message: `efk check could not run: ${String(error)}` })
                        }
                    })()
                }, deps.checkDelayMs)
            }

            await new Promise<void>((resolveExit) => {
                if (finished) {
                    resolveExit()
                    return
                }
                finish = resolveExit
            })
            return 0
        } finally {
            // Otherwise every `efk start` in a long-lived process leaves two listeners behind, and
            // Node starts warning about a leak after ten.
            process.off('SIGINT', onSignal)
            process.off('SIGTERM', onSignal)
        }
    } finally {
        lock.release()
    }
}
