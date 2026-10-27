import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { createEventBus, type EventBus } from '../core/events'
import type { FleetManager } from '../core/fleet-manager'
import type { RobotDriver } from '../driver/robot-driver'
import { createSimulatedDriver } from '../driver/simulated'
import { botScenarioSchema } from '../driver/simulated/scenario'
import { createWebApp, isLoopbackHost, startWeb } from './index'

const T0 = 1_800_000_000_000

const manager = {
    bots: () => [],
    config: () => null,
    capabilities: () => ({ supports_command_interrupt: true, default: { has_door: true, supported_commands: [] } }),
    driver: () => undefined,
} as unknown as FleetManager

/**
 * A real simulated driver (the manual controls are only found on it), same recipe as
 * `tui/model.test.ts`. `nowRef` is mutable so a door-transition test can advance the clock and call
 * `.tick()` itself — the CLI's own loop does that in a running `efk start` (`start.ts:296`); nothing
 * in the web route does, same as nothing in the TUI's `d` key does either.
 */
function simulatedDriver(over: Record<string, unknown> = {}, nowRef = { t: T0 }) {
    const scenario = botScenarioSchema.parse(over)
    return createSimulatedDriver({
        botId: 'ACME-0001',
        scenario,
        origin: { lat: 0, lng: 0 },
        scatterRadiusM: 0,
        now: () => nowRef.t,
        random: () => 0.5,
    })
}

/**
 * A `FleetManager` whose one bot is backed by `driver`. `bots()` returns the sliver of `BotRuntime`
 * the control routes actually use (`botId`, `snapshot()`, `touch()`) — the same shape `ToggleTarget`
 * names in `../core/manual-controls`, so a test double does not have to build a whole runtime.
 */
function managerFor(driver: RobotDriver): FleetManager {
    const runtime = { botId: driver.botId, snapshot: () => driver.snapshot(), touch: () => {} }
    return {
        bots: () => [runtime],
        config: () => null,
        capabilities: () => ({ supports_command_interrupt: true, default: { has_door: true, supported_commands: [] } }),
        driver: (botId: string) => (botId === driver.botId ? driver : undefined),
    } as unknown as FleetManager
}

/**
 * A bus that counts its live `onAny` subscriptions. That count is the observable form of "the
 * dashboard let go": `createWebApp` takes exactly one to fold every event into its model, and
 * `close()` is what gives it back.
 */
function countingBus(): { bus: EventBus; live: () => number } {
    const inner = createEventBus()
    let live = 0
    return {
        bus: {
            ...inner,
            onAny: (handler) => {
                live += 1
                const off = inner.onAny(handler)
                let released = false
                return () => {
                    if (!released) {
                        released = true
                        live -= 1
                    }
                    off()
                }
            },
        },
        live: () => live,
    }
}

describe('web dashboard', () => {
    it('serves the page and a JSON snapshot', async () => {
        const app = createWebApp({ bus: createEventBus(), manager })
        const page = await app.request('/')
        assert.equal(page.status, 200)
        assert.match(page.headers.get('content-type') ?? '', /text\/html/)
        assert.match(await page.text(), /EventSource\('\/events'\)/)
        const snap = await app.request('/api/snapshot')
        assert.equal(snap.status, 200)
        assert.deepEqual(Object.keys((await snap.json()) as object).sort(), [
            'bots',
            'commands',
            'controlsEnabled',
            'demo',
            'events',
            'log',
            'namespace',
        ])
    })
    it('the snapshot carries the demo flag the page needs to raise its red band', async () => {
        // `page.ts`'s `render()` reads `s.demo` and this is the FIRST thing it renders, before any
        // SSE has arrived. If the flag were missing here the DEMO band would depend entirely on the
        // stream connecting — and in demo mode nothing else on the page says the fleet is invented.
        const demo = createWebApp({ bus: createEventBus(), manager, demo: true })
        const onSnapshot = (await (await demo.request('/api/snapshot')).json()) as {
            demo: boolean
            namespace: string | null
            bots: unknown[]
        }
        assert.equal(onSnapshot.demo, true)
        // Paired: the rest of the payload is real, so `demo: true` is not all that survived.
        assert.equal(onSnapshot.namespace, null)
        assert.deepEqual(onSnapshot.bots, [])
        demo.close()

        const live = createWebApp({ bus: createEventBus(), manager })
        const offSnapshot = (await (await live.request('/api/snapshot')).json()) as { demo: boolean }
        assert.equal(offSnapshot.demo, false)
        live.close()
    })
    it('replays what the bus buffered before it mounted, DEMO MODE warning included', async () => {
        const bus = createEventBus()
        // Exactly the order `startWith` runs in: the demo banner is logged long before --web binds.
        bus.emit('log', { level: 'warn', message: 'DEMO MODE — not connected to remi.' })
        bus.emit('log', { level: 'info', message: 'fleet started' })
        const app = createWebApp({ bus, manager, demo: true })
        const snap = (await (await app.request('/api/snapshot')).json()) as { log: Array<{ level: string; message: string }> }
        // Newest first, both present, and the levels survived the replay.
        assert.deepEqual(
            snap.log.map((l) => `${l.level} ${l.message}`),
            ['info fleet started', 'warn DEMO MODE — not connected to remi.'],
        )
        app.close()
    })
    it('/events is an SSE stream: first a snapshot, then every bus event', async () => {
        const bus = createEventBus()
        const app = createWebApp({ bus, manager })
        const res = await app.request('/events')
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
        const reader = res.body?.getReader()
        assert.ok(reader)

        // The stream opens with `event: snapshot` (see createWebApp), so the first chunk is NOT the
        // log line. Read until the log event shows up instead of asserting on whatever arrived first.
        const decoder = new TextDecoder()
        const first = decoder.decode((await reader.read()).value)
        assert.match(first, /event: snapshot/)

        bus.emit('log', { level: 'info', message: 'hello sse' })
        let seen = ''
        for (let i = 0; i < 10 && !seen.includes('event: log'); i += 1) {
            const { value, done } = await reader.read()
            if (done) break
            seen += decoder.decode(value)
        }
        assert.match(seen, /event: log/)
        assert.match(seen, /hello sse/)
        await reader.cancel()
        app.close()
    })
    it('binds to 127.0.0.1 unless a host is given', async () => {
        const addresses: AddressInfo[] = []
        const stop = await startWeb({
            bus: createEventBus(),
            manager,
            host: '127.0.0.1',
            port: 0,
            demo: false,
            onListening: (addr) => addresses.push(addr),
        })
        assert.equal(addresses[0]?.address, '127.0.0.1')
        await stop()
    })
    it('warns when it is exposed beyond loopback, and says the controls are disabled there', async () => {
        const bus = createEventBus()
        const warnings: string[] = []
        bus.on('log', (l) => warnings.push(l.message))
        const stop = await startWeb({ bus, manager, host: '0.0.0.0', port: 0, demo: false })
        const warning = warnings.join('\n')
        assert.match(warning, /Keep it on 127\.0\.0\.1/)
        // The old warning only said state was visible. Controls change what is at stake: the warning
        // must say, plainly, that they are off on this host rather than merely present and risky.
        assert.match(warning, /DISABLED/)
        assert.match(warning, /visible to the network/)
        await stop()
    })
    it('stop() unsubscribes from the bus', async () => {
        const { bus, live } = countingBus()
        const stop = await startWeb({ bus, manager, host: '127.0.0.1', port: 0, demo: false })
        assert.equal(live(), 1)
        await stop()
        // Nothing throws and nothing accumulates: the app is gone, not still folding events into a
        // model that will never be read. Long-running `efk start` sessions restart the dashboard.
        assert.equal(live(), 0)
        bus.emit('log', { level: 'info', message: 'after stop' })
        assert.equal(live(), 0)
    })
})

describe('web dashboard, manual controls (THE SEAM: HTTP route -> shared control -> driver)', () => {
    it('answers 404 for an unknown bot before asking any driver anything', async () => {
        const app = createWebApp({ bus: createEventBus(), manager: managerFor(simulatedDriver()) })
        const res = await app.request('/api/bots/NOPE-0000/controls/available', { method: 'POST' })
        assert.equal(res.status, 404)
        assert.equal(((await res.json()) as { error: string }).error, 'bot_not_found')
        app.close()
    })

    it('refuses a driver with no manual controls, structurally, not with a throw', async () => {
        const bare = { botId: 'ACME-0001', driverVersion: 1 } as unknown as RobotDriver
        const app = createWebApp({ bus: createEventBus(), manager: managerFor(bare) })
        const res = await app.request('/api/bots/ACME-0001/controls/available', { method: 'POST' })
        assert.equal(res.status, 422)
        assert.equal(((await res.json()) as { error: string }).error, 'no_controls')
        app.close()
    })

    it("available: toggles through the route, and reads back the DRIVER'S verdict — not our assumption", async () => {
        const driver = simulatedDriver({ available: true })
        await driver.start({ now: () => T0, log: () => {} })
        const app = createWebApp({ bus: createEventBus(), manager: managerFor(driver) })
        const res = await app.request('/api/bots/ACME-0001/controls/available', { method: 'POST' })
        assert.equal(res.status, 200)
        const body = (await res.json()) as { ok: boolean; requested: boolean; applied: boolean; note: string | null }
        assert.equal(body.ok, true)
        assert.equal(body.requested, false)
        assert.equal(body.applied, true)
        assert.equal(body.note, null)
        app.close()
    })

    it('available: on a flat battery the toggle does NOT win, and the response carries applied:false and why', async () => {
        const driver = simulatedDriver({ battery: { startPct: 10, unavailableBelowPct: 20 }, available: false })
        await driver.start({ now: () => T0, log: () => {} })
        const app = createWebApp({ bus: createEventBus(), manager: managerFor(driver) })
        const res = await app.request('/api/bots/ACME-0001/controls/available', { method: 'POST' })
        assert.equal(res.status, 200)
        const body = (await res.json()) as { ok: boolean; requested: boolean; applied: boolean; note: string | null }
        assert.equal(body.requested, true)
        assert.equal(body.applied, false)
        assert.match(body.note ?? '', /had no effect on ACME-0001/)
        assert.match(body.note ?? '', /10% battery/)
        app.close()
    })

    it('door: the route actually commands the driver — the transition settles once it ticks, same as the TUI key', async () => {
        // Neither this route nor the TUI's `d` key advances the simulated clock: `efk start`'s own
        // loop does (`start.ts:296`), so the honest assertion is that the COMMAND reached the driver,
        // not that `snapshot().door` changed synchronously inside the request.
        const now = { t: T0 }
        const driver = simulatedDriver({ door: { hasDoor: true, transitionMs: 100 } }, now)
        await driver.start({ now: () => now.t, log: () => {} })
        const app = createWebApp({ bus: createEventBus(), manager: managerFor(driver) })
        assert.equal(driver.snapshot().door, 'closed')
        const res = await app.request('/api/bots/ACME-0001/controls/door', { method: 'POST' })
        assert.equal(res.status, 200)
        const body = (await res.json()) as { ok: boolean; door: string }
        assert.equal(body.ok, true)
        now.t += 200
        driver.tick(now.t)
        assert.equal(driver.snapshot().door, 'opened')
        app.close()
    })

    it('door: refuses a doorless bot with a reason, rather than pretending to toggle it', async () => {
        const driver = simulatedDriver({ door: { hasDoor: false } })
        await driver.start({ now: () => T0, log: () => {} })
        const app = createWebApp({ bus: createEventBus(), manager: managerFor(driver) })
        const res = await app.request('/api/bots/ACME-0001/controls/door', { method: 'POST' })
        assert.equal(res.status, 422)
        const body = (await res.json()) as { ok: boolean; error: string }
        assert.equal(body.ok, false)
        assert.equal(body.error, 'no_door')
        app.close()
    })

    it('link: cycles THREE states — scenario(null) -> pinned down(true) -> pinned up(false) -> scenario(null)', async () => {
        const driver = simulatedDriver({ link: { mode: 'offline' } })
        await driver.start({ now: () => T0, log: () => {} })
        const app = createWebApp({ bus: createEventBus(), manager: managerFor(driver) })
        const post = () => app.request('/api/bots/ACME-0001/controls/link', { method: 'POST' })

        let body = (await (await post()).json()) as { pin: boolean | null; connected: boolean; label: string }
        assert.equal(body.pin, true)
        assert.equal(body.connected, false)
        assert.equal(body.label, 'down*')

        body = (await (await post()).json()) as { pin: boolean | null; connected: boolean; label: string }
        assert.equal(body.pin, false)
        assert.equal(body.connected, true)
        assert.equal(body.label, 'up*')

        body = (await (await post()).json()) as { pin: boolean | null; connected: boolean; label: string }
        // Back to the scenario (`offline`), not pinned online — the third press must hand it back.
        assert.equal(body.pin, null)
        assert.equal(body.connected, false)
        assert.equal(body.label, 'down')
        app.close()
    })

    it('blocked: toggles emitBlocked/emitUnblocked and reports which one just ran', async () => {
        const driver = simulatedDriver()
        await driver.start({ now: () => T0, log: () => {} })
        const events: string[] = []
        driver.on('blocked', () => events.push('blocked'))
        driver.on('unblocked', () => events.push('unblocked'))
        const app = createWebApp({ bus: createEventBus(), manager: managerFor(driver) })
        const post = () => app.request('/api/bots/ACME-0001/controls/blocked', { method: 'POST' })

        let body = (await (await post()).json()) as { blocked: boolean }
        assert.equal(body.blocked, true)
        body = (await (await post()).json()) as { blocked: boolean }
        assert.equal(body.blocked, false)
        assert.deepEqual(events, ['blocked', 'unblocked'])
        app.close()
    })

    it('a driver that throws costs the request and a note, never a 500 that could carry what it was holding', async () => {
        const LEAK = 'live_sk_this_must_never_be_printed'
        const hostile = {
            botId: 'ACME-0001',
            driverVersion: 1,
            setAvailable: () => {
                throw new Error(LEAK)
            },
            toggleDoorLocally: () => {},
            setOffline: () => {},
            emitBlocked: () => {},
            emitUnblocked: () => {},
            capabilities: () => ({ hasDoor: true, supportedCommands: [] }),
            snapshot: () => ({ position: null, batteryPercentage: 50, door: 'closed', available: false, connected: true }),
        } as unknown as RobotDriver
        const app = createWebApp({ bus: createEventBus(), manager: managerFor(hostile) })
        const res = await app.request('/api/bots/ACME-0001/controls/available', { method: 'POST' })
        assert.equal(res.status, 503)
        const body = (await res.json()) as { ok: boolean; error: string; note: string }
        assert.equal(body.ok, false)
        assert.equal(body.error, 'driver_error')
        assert.match(body.note, /^ACME-0001 refused that key: /)
        assert.equal(body.note.includes(LEAK), false)
        app.close()
    })

    /**
     * THE STRUCTURAL GUARD: the four
     * control routes must not just refuse on a non-loopback host, they must not EXIST. This is the
     * one test that discriminates a route mounted unconditionally from a route mounted only on
     * loopback — see the mutation note in the task report for the failure this was run against.
     */
    it('mounts the control routes on loopback and NOT AT ALL on a non-loopback host (404, not a refusal)', async () => {
        const driver = simulatedDriver()
        await driver.start({ now: () => T0, log: () => {} })

        const loopback = createWebApp({ bus: createEventBus(), manager: managerFor(driver), host: '127.0.0.1' })
        const loopbackRes = await loopback.request('/api/bots/ACME-0001/controls/blocked', { method: 'POST' })
        assert.equal(loopbackRes.status, 200)
        loopback.close()

        const exposed = createWebApp({ bus: createEventBus(), manager: managerFor(driver), host: '0.0.0.0' })
        const exposedRes = await exposed.request('/api/bots/ACME-0001/controls/blocked', { method: 'POST' })
        assert.equal(exposedRes.status, 404)
        exposed.close()

        const snap = (await (await exposed.request('/api/snapshot')).json()) as { controlsEnabled: boolean }
        assert.equal(snap.controlsEnabled, false)
    })

    it('isLoopbackHost: 127.0.0.1, localhost and ::1 are loopback; 0.0.0.0 and a LAN address are not', () => {
        assert.equal(isLoopbackHost('127.0.0.1'), true)
        assert.equal(isLoopbackHost('localhost'), true)
        assert.equal(isLoopbackHost('::1'), true)
        assert.equal(isLoopbackHost('0.0.0.0'), false)
        assert.equal(isLoopbackHost('192.168.1.20'), false)
    })
})
