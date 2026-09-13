/**
 * `efk start` is a long-running process that owns a lock file, a state file, a fleet and a screen,
 * so what can be tested here is what `startWith` itself decides: the demo announcement, the
 * `--check` wiring, the idempotence of shutdown, and the four cross-task debts that land in this
 * function. Everything environmental arrives through `StartDeps`, so no test binds a port, reads a
 * `.env`, writes into the repository, or waits ten seconds.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { KitConfig } from '../config'
import { createEventBus, type EventBus, type KitEvents } from '../core/events'
import { FakeDriver } from '../core/fakes'
import type { FleetManager, FleetManagerDeps } from '../core/fleet-manager'
import { createStateStore } from '../core/state-store'
import type { CheckDeps, CheckReport } from './check'
import { type Env, loadEnv } from './env'
import type { LockResult } from './lock'
import { DEMO_BANNER, type StartDeps, type StartOptions, startWith } from './start'

const envSource = {
    REMI_API_URL: 'https://remi.invalid',
    REMI_API_KEY: `live_sk_${'0'.repeat(48)}`,
    REMI_TRANSPORT: 'mqtt',
    MQTT_HOST: 'broker.invalid',
    MQTT_USERNAME: 'fleet_acme',
    MQTT_PASSWORD: 'secret-broker-password',
    SANDBOX_LOCATION_ID: 'L1',
    SANDBOX_CENTER_LAT: '0',
    SANDBOX_CENTER_LNG: '0',
}
function goodEnv(): Env {
    const parsed = loadEnv(envSource)
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.env
}

const kitConfig: KitConfig = { driver: (botId: string) => new FakeDriver(botId), fleet: { supportsCommandInterrupt: true } }

/**
 * `headless: false` by default: the fake TUI is what hands the test `onQuit`, and `onQuit` is the
 * only way to end a `startWith` that is otherwise waiting for a signal. A headless default would
 * make every one of these tests hang for ever, which node's runner — default timeout `Infinity` —
 * would report as nothing at all.
 */
const options = (overrides: Partial<StartOptions> = {}): StartOptions => ({
    web: false,
    webHost: '127.0.0.1',
    headless: false,
    check: false,
    demo: false,
    ...overrides,
})

function fakeManager(overrides: Partial<FleetManager> = {}): FleetManager {
    return {
        start: async () => ({ ok: true, roster: ['ACME-0001'] }),
        stop: async () => {},
        bots: () => [],
        driver: () => undefined,
        config: () => null,
        capabilities: () => ({ supports_command_interrupt: true, default: { has_door: false, supported_commands: [] } }),
        refreshCapabilities: async () => {},
        tickOnce: async () => {},
        serve: () => [],
        ...overrides,
    }
}

type Harness = {
    deps: StartDeps
    bus: EventBus
    logs: Array<KitEvents['log']>
    /** The TUI's `q` handler, once the (fake) TUI has mounted. */
    quit: () => (() => void) | null
    stops: string[]
    checkCalls: CheckDeps[]
    lockReleased: () => number
    tmp: string
}

function harness(over: Partial<StartDeps> = {}, managerOver: Partial<FleetManager> = {}): Harness {
    const bus = createEventBus()
    const logs: Array<KitEvents['log']> = []
    bus.on('log', (payload) => logs.push(payload))
    const stops: string[] = []
    const checkCalls: CheckDeps[] = []
    let onQuit: (() => void) | null = null
    let released = 0
    const tmp = mkdtempSync(join(tmpdir(), 'efk-start-'))
    created.push(tmp)

    const deps: StartDeps = {
        createEventBus: () => bus,
        startTui: async (opts) => {
            onQuit = opts.onQuit
            return () => stops.push('tui')
        },
        startWeb: async () => async () => {
            stops.push('web')
        },
        createFleetManager: (_managerDeps: FleetManagerDeps) =>
            fakeManager({
                stop: async () => {
                    stops.push('manager')
                },
                ...managerOver,
            }),
        loadEnv: () => ({ ok: true, env: goodEnv() }),
        loadConfig: async () => ({ ok: true, config: kitConfig }),
        acquireLock: () => ({
            release: () => {
                released += 1
            },
        }),
        createStateStore,
        runCheck: async (checkDeps) => {
            checkCalls.push(checkDeps)
            return { rules: [], exitCode: 0 } as CheckReport
        },
        listScenarios: () => ['default', 'low-battery', 'no-interrupt'],
        lockPath: join(tmp, '.efk.lock'),
        statePath: join(tmp, '.efk-state.json'),
        checkDelayMs: 0,
        ...over,
    }
    return { deps, bus, logs, quit: () => onQuit, stops, checkCalls, lockReleased: () => released, tmp }
}

/** Bounded: node's default test timeout is Infinity, so nothing here may wait for ever. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

/** Every temp directory a harness made, removed after each test: this suite leaves no files. */
const created: string[] = []

let warned: string[] = []
let errored: string[] = []
const realWarn = console.warn
const realError = console.error
beforeEach(() => {
    warned = []
    errored = []
    console.warn = (...args: unknown[]) => warned.push(args.map(String).join(' '))
    console.error = (...args: unknown[]) => errored.push(args.map(String).join(' '))
})
afterEach(() => {
    console.warn = realWarn
    console.error = realError
    for (const dir of created) rmSync(dir, { recursive: true, force: true })
    created.length = 0
})

describe('efk start', () => {
    it('announces demo mode on the console and on the bus, and never starts without saying so', async () => {
        const h = harness()
        const running = startWith(options({ demo: true }), h.deps)
        await waitFor('the TUI to mount', () => h.quit() !== null)
        h.quit()?.()
        assert.equal(await running, 0)

        assert.ok(
            warned.some((line) => line.includes(DEMO_BANNER)),
            'the banner reaches the terminal before the TUI takes the screen',
        )
        assert.ok(
            h.logs.some((entry) => entry.message.includes(DEMO_BANNER)),
            'and the bus carries it too, for the TUI and the dashboard',
        )
    })

    it('hands `demo: true` to efk check when --check is on', async () => {
        const h = harness()
        const running = startWith(options({ demo: true, check: true }), h.deps)
        await waitFor('efk check to run', () => h.checkCalls.length > 0)
        const call = h.checkCalls[0]
        assert.ok(call)
        assert.equal(call.demo, true)
        assert.equal(call.env?.REMI_TRANSPORT, 'mqtt')
        // Started from a real signal handler path; stop it the way `q` does.
        h.quit()?.()
        assert.equal(await running, 0)
    })

    it('shuts down once, in reverse order, however many times it is asked', async () => {
        const h = harness()
        const running = startWith(options({ web: true }), h.deps)
        await waitFor('the TUI to mount', () => h.quit() !== null)
        const quit = h.quit()
        assert.ok(quit)
        quit()
        quit()
        quit()
        assert.equal(await running, 0)
        assert.deepEqual(h.stops, ['tui', 'web', 'manager'], 'reverse registration order, exactly once each')
        assert.equal(h.lockReleased(), 1)
    })

    /**
     * DEBT 1, the critical one. A `.efk-state.json` that cannot be parsed is discarded and every
     * per-bot `seq` restarts at 1. remi discards any state whose `seq` is not above the last one it
     * stored, and a bot a week into a run at 4 Hz sits near 2.4 million — so a silent reset is days
     * of invisible rejection for that bot. Nothing listened to `onDiscard` until this task.
     *
     * The store is REAL and the file is really malformed, because the property under test is not
     * "a handler exists" but "the handler this construction passes is the one that fires". The
     * discard happens inside `createSeq`, which calls `store.read()` while constructing, so a
     * listener attached to the store afterwards would be attached to an event that already fired —
     * and this test would fail, which is the point of writing it this way.
     */
    it('says so, loudly, when the persisted seq counters are discarded', async () => {
        const h = harness()
        writeFileSync(h.deps.statePath, '{ this is not json')
        const running = startWith(options(), h.deps)
        await waitFor('the TUI to mount', () => h.quit() !== null)
        h.quit()?.()
        assert.equal(await running, 0)

        const onBus = h.logs.filter((entry) => entry.level === 'warn' && entry.message.includes('seq counters restart at 1'))
        assert.equal(onBus.length, 1, 'the discard reaches the bus as a WARNING, not as info')
        assert.ok(
            warned.some((line) => line.includes('seq counters restart at 1')),
            'and the terminal, since nothing is subscribed to the bus this early in startup',
        )
        assert.ok(onBus[0]?.message.includes(h.deps.statePath), 'naming the file it gave up on')
    })

    it('leaves a readable state file alone and says nothing', async () => {
        const h = harness()
        writeFileSync(h.deps.statePath, JSON.stringify({ v: 1, seq: { 'ACME-0001': 2_400_000 } }))
        const running = startWith(options(), h.deps)
        await waitFor('the fleet to start', () => h.quit() !== null)
        h.quit()?.()
        assert.equal(await running, 0)
        assert.equal(
            h.logs.filter((entry) => entry.message.includes('seq counters restart')).length,
            0,
            'a perfectly good state file must not be announced as a discard',
        )
    })

    /**
     * DEBT 2. `acquireLock` has three outcomes, not two: losing a race for a lock whose file we
     * cannot read has no holder to name. The old shape answered `{ held: { pid: -1, since: now } }`,
     * which printed at a partner as "already running (pid -1) since just now" — a pid that does not
     * exist and a timestamp that is ours, not the holder's.
     */
    it('refuses a contended lock without inventing a holder', async () => {
        const h = harness({ acquireLock: (): LockResult => ({ contended: true }) })
        assert.equal(await startWith(options(), h.deps), 1)
        const line = errored.join('\n')
        assert.ok(line.includes('conflicting seq'), 'says why two instances are not allowed')
        assert.ok(!line.includes('pid -1'), 'and does not invent a pid')
        assert.ok(!/pid \d/.test(line), 'or name any holder at all, because it does not know one')
        assert.equal(h.stops.length, 0, 'nothing was started')
    })

    it('names the holder when the lock file does say who it is', async () => {
        const h = harness({ acquireLock: (): LockResult => ({ held: { pid: 4321, since: 1_800_000_000_000 } }) })
        assert.equal(await startWith(options(), h.deps), 1)
        assert.ok(errored.join('\n').includes('pid 4321'))
        assert.equal(h.stops.length, 0)
    })

    /**
     * DEBT 3. `scenarioPath(name)` does no validation whatsoever: it joins the name into
     * `scenarios/<name>.json`, so a name with `..` in it reads an arbitrary JSON file off the
     * partner's disk. The known list is the entire grammar this flag has.
     */
    it('refuses a --scenario outside the bundled set, before touching anything', async () => {
        const before = process.env.EFK_SCENARIO
        let lockTaken = false
        const h = harness({
            acquireLock: () => {
                lockTaken = true
                return { release: () => {} }
            },
        })
        assert.equal(await startWith(options({ scenario: '../../../etc/passwd' }), h.deps), 1)
        assert.ok(errored.join('\n').includes("unknown scenario '../../../etc/passwd'"))
        assert.ok(errored.join('\n').includes('default'), 'and lists the ones that do exist')
        assert.equal(lockTaken, false, 'a typo must not create and delete a lock file')
        assert.equal(process.env.EFK_SCENARIO, before, 'and must never reach EFK_SCENARIO')
    })

    it('accepts a --scenario that is on the list', async () => {
        const before = process.env.EFK_SCENARIO
        try {
            const h = harness()
            const running = startWith(options({ scenario: 'low-battery' }), h.deps)
            await waitFor('the fleet to start', () => h.quit() !== null)
            h.quit()?.()
            assert.equal(await running, 0)
            assert.equal(process.env.EFK_SCENARIO, 'low-battery')
        } finally {
            if (before === undefined) delete process.env.EFK_SCENARIO
            else process.env.EFK_SCENARIO = before
        }
    })

    it('releases the lock and leaves no signal listener behind when the fleet refuses to start', async () => {
        const before = process.listenerCount('SIGINT')
        const h = harness({}, { start: async () => ({ ok: false, reason: 'empty_roster', detail: 'no bots registered' }) })
        assert.equal(await startWith(options(), h.deps), 1)
        assert.ok(errored.join('\n').includes('no bots registered'))
        assert.equal(h.lockReleased(), 1)
        assert.equal(process.listenerCount('SIGINT'), before)
    })

    it('removes its signal listeners on the way out', async () => {
        const before = process.listenerCount('SIGINT')
        const h = harness()
        const running = startWith(options(), h.deps)
        await waitFor('the fleet to start', () => h.quit() !== null)
        assert.equal(process.listenerCount('SIGINT'), before + 1, 'installed while running')
        h.quit()?.()
        assert.equal(await running, 0)
        assert.equal(process.listenerCount('SIGINT'), before, 'and gone afterwards')
    })
})
