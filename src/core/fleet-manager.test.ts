import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { BotCommand, BotState, FleetConfigResponse } from '../contract/schemas'
import type { CommandOutcome } from '../core/events'
import type { RemiClient } from '../remi/client'
import type { Transport } from '../transport/transport'
import { IDLE_HEARTBEAT_MS } from './cadence'
import { MAX_UNPUBLISHED_TERMINALS } from './command-ledger'
import { createEventBus, type EventBus } from './events'
import { FakeClock, FakeDriver } from './fakes'
import { createFleetManager, selectRoster } from './fleet-manager'
import { createSeq, type Seq } from './seq'
import { createStateStore } from './state-store'

// Every temp directory is remembered so the run leaves nothing behind, in the repo or in /tmp.
const dirs: string[] = []
after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const mirror = (id: string) => ({
    bot_id: id,
    location_id: 'L',
    assignable: false,
    blocked_by: ['disconnected' as const],
    state_age_ms: null,
    current_job_id: null,
})
const config = {
    namespace: 'acme',
    bot_id_prefix: 'ACME-',
    transport: 'mqtt' as const,
    base_url: null,
    token_set: false,
    poll_interval_active_ms: 2000,
    poll_interval_idle_ms: 15000,
    max_bots: 2,
    contract_version: '2026-09',
}

function fakeRemi(overrides: Partial<RemiClient> = {}): RemiClient {
    return {
        getFleetConfig: async () => ({ ok: true, data: config }),
        listFleetBots: async () => ({ ok: true, data: [mirror('ACME-0001'), mirror('ACME-0002'), mirror('ACME-0003')] }),
        listDeliveries: async () => ({ ok: true, data: null }),
        createDelivery: async () => ({ ok: false, status: 0, code: 'X', message: '' }),
        getDelivery: async () => ({ ok: false, status: 0, code: 'X', message: '' }),
        pushState: async () => ({ ok: true, data: { accepted: 0, rejected: 0 } }),
        reportEvent: async () => ({ ok: true, data: { accepted: true } }),
        setCapabilities: async (caps) => ({ ok: true, data: caps }),
        ...overrides,
    }
}

class FakeTransport implements Transport {
    readonly kind = 'mqtt' as const
    states: BotState[] = []
    started: string[] = []
    flushes = 0
    /** Flip to false to imitate a bot the link policy has taken offline. */
    delivers = true
    /** What the manager passed as the second argument of transportFor. */
    namespaceSeen: string | null = null
    /** What the manager handed to onCommand: the door remi's commands come in through. */
    handler: ((botId: string, command: BotCommand) => Promise<CommandOutcome>) | null = null
    async start(bots: { botId: string }[]) {
        this.started = bots.map((b) => b.botId)
    }
    /** The manager's roster loop tells the transport who it serves now; the test reads it from `started`. */
    async setBots(bots: { botId: string }[]) {
        this.started = bots.map((b) => b.botId)
    }
    async stop() {}
    async publishState(_botId: string, state: BotState) {
        if (!this.delivers) return false
        this.states.push(state)
        return true
    }
    async publishEvent() {
        return this.delivers
    }
    async flushTick() {
        this.flushes += 1
    }
    onCommand(handler: (botId: string, command: BotCommand) => Promise<CommandOutcome>) {
        this.handler = handler
    }
}

function harness(remi = fakeRemi(), bus: EventBus = createEventBus(), driverVersionFor: (botId: string) => number = () => 1) {
    const clock = new FakeClock()
    const transport = new FakeTransport()
    const drivers = new Map<string, FakeDriver>()
    const warnings: string[] = []
    /** Every driver the manager asked for, in order, with the `fleet_serial` it was built against. */
    const built: Array<{ botId: string; fleetSerial: string | null }> = []
    /** Bots whose driver was stopped — a roster drop and a remap both go through here. */
    const stopped: string[] = []
    bus.on('log', (l) => {
        if (l.level === 'warn') warnings.push(l.message)
    })
    const dir = mkdtempSync(join(tmpdir(), 'efk-'))
    dirs.push(dir)
    const manager = createFleetManager({
        remi,
        transportFor: (_kind, config) => {
            transport.namespaceSeen = config.namespace
            return transport
        },
        driverFor: (botId, fleetSerial) => {
            const d = new FakeDriver(botId)
            // `driverVersion` is the literal 1 on the fake; the start-time gate needs a test that can
            // make one bot answer something else.
            Object.assign(d, { driverVersion: driverVersionFor(botId) })
            built.push({ botId, fleetSerial })
            const stop = d.stop.bind(d)
            d.stop = async () => {
                stopped.push(botId)
                await stop()
            }
            drivers.set(botId, d)
            return d
        },
        fleet: { supportsCommandInterrupt: true },
        env: { transport: 'mqtt' },
        bus,
        // The debounced write must not hold the test process open for a second per harness.
        seq: createSeq(createStateStore(join(dir, '.efk-state.json')), { setTimer: (fn, ms) => setTimeout(fn, ms).unref() }),
        now: clock.now,
        tickMs: 0,
        // The loop is driven by hand through `reconcileOnce()`: a live interval would hold the test
        // process open, and a wall-clock cadence would make these tests timing-dependent.
        rosterRefreshMs: 0,
    })
    return { manager, transport, drivers, clock, warnings, built, stopped }
}

/** A command remi issued that is already past its deadline: rejected without ever reaching the driver. */
const expired = (id: string): BotCommand => ({
    id,
    type: 'navigate_to',
    params: { lat: 33.97, lng: -118.41 },
    issued_at: new Date(1_799_999_000_000).toISOString(),
    expires_at: new Date(1_799_999_900_000).toISOString(),
})

/** A command the driver accepts, so the bot has something live in the slot. */
const live = (id: string): BotCommand => ({
    id,
    type: 'navigate_to',
    params: { lat: 33.97, lng: -118.41 },
    issued_at: new Date(1_799_999_000_000).toISOString(),
})

describe('selectRoster', () => {
    const row = (id: string, extra: Partial<{ fleet_serial: string | null; blocked_by: string[] }> = {}) => ({
        bot_id: id,
        fleet_serial: null,
        blocked_by: [] as string[],
        ...extra,
    })

    it('applies the cap BEFORE the mapping gate: a bot nobody drives cannot park the fleet', () => {
        // The opposite was reproduced in review: 49 good bots plus one unmapped row past max_bots, and
        // the whole fleet went idle for a robot that was never going to be driven.
        const roster = [row('ACME-0173', { fleet_serial: 'SN-0001' }), row('ACME-0175', { fleet_serial: 'SN-0002' }), row('ACME-9999')]
        const s = selectRoster(roster, { requiresFleetSerial: true, maxBots: 2 })
        assert.deepEqual(
            s.serve.map((b) => b.botId),
            ['ACME-0173', 'ACME-0175'],
        )
        assert.deepEqual(s.unmapped, [], 'the unmapped row is beyond the cap, so it is not our problem')
    })

    it('still parks the fleet when an unmapped bot IS within the cap', () => {
        const s = selectRoster([row('ACME-0173', { fleet_serial: 'SN-0001' }), row('ACME-9999')], {
            requiresFleetSerial: true,
            maxBots: 10,
        })
        assert.deepEqual(s.unmapped, ['ACME-9999'])
    })

    it('drops retired rows, so a live bot may reuse a retired one\u2019s serial', () => {
        // remi allows the reuse; the preflight used to call it a duplicate because it built drivers
        // for retired bots too.
        const roster = [
            row('ACME-0001', { fleet_serial: 'SN-0001', blocked_by: ['retired'] }),
            row('ACME-0002', { fleet_serial: 'SN-0001' }),
        ]
        const s = selectRoster(roster, { requiresFleetSerial: true, maxBots: 10 })
        assert.deepEqual(s.active, ['ACME-0002'])
        assert.deepEqual(
            s.serve.map((b) => b.fleetSerial),
            ['SN-0001'],
        )
        assert.deepEqual(s.unmapped, [])
    })

    it('ignores mappings entirely when the fleet does not require them', () => {
        const s = selectRoster([row('ACME-0001')], { requiresFleetSerial: false, maxBots: 10 })
        assert.deepEqual(s.unmapped, [])
    })
})

describe('fleet manager', () => {
    it('discovers the roster, caps it at max_bots and starts one driver per bot', async () => {
        const { manager, transport, drivers } = harness()
        const result = await manager.start()
        assert.deepEqual(result, { ok: true, roster: ['ACME-0001', 'ACME-0002'] })
        assert.deepEqual([...drivers.keys()], ['ACME-0001', 'ACME-0002'])
        assert.deepEqual(transport.started, ['ACME-0001', 'ACME-0002'])
        assert.equal(transport.namespaceSeen, 'acme', 'the transport is built with the namespace remi gave us, never an empty string')
        assert.equal(manager.driver('ACME-0001'), drivers.get('ACME-0001'))
        assert.equal(manager.driver('ACME-0009'), undefined)
        await manager.stop()
        assert.deepEqual(manager.bots(), [], 'stop() empties the runtimes: a second start must not stack a second fleet on top')
    })
    it('starts IDLE on an empty roster: no runtimes, still registered with remi, and says so once', async () => {
        // The whole point of the idle start: a pod can be deployed and verified before anyone has
        // registered a bot against the fleet. It must come up, tell remi it exists, and publish
        // nothing — not refuse, which is what made a deployment impossible to check on its own.
        let sentCapabilities = false
        const { manager, transport, warnings } = harness(
            fakeRemi({
                listFleetBots: async () => ({ ok: true, data: [] }),
                setCapabilities: async (caps) => {
                    sentCapabilities = true
                    return { ok: true, data: caps }
                },
            }),
        )
        const result = await manager.start()
        assert.deepEqual(result, { ok: true, roster: [] })
        assert.deepEqual(manager.bots(), [], 'no runtimes exist')
        assert.deepEqual(transport.started, [], 'the transport is up, with nothing to carry')
        assert.deepEqual(manager.serve(), [], 'a poll answers an empty fleet rather than failing')
        // NOT registered: with no runtimes the document would say `has_door: false` and
        // `supported_commands: []` for the whole fleet, and remi would drop every `set_door` and turn
        // `manual_close_door` on for good. An idle start leaves whatever remi already holds standing.
        assert.equal(sentCapabilities, false, 'an idle fleet does not overwrite the capabilities document')
        assert.equal(warnings.filter((w) => w.startsWith('idle:')).length, 1, 'said once, and actionable')
        await manager.tickOnce()
        assert.deepEqual(transport.states, [], 'an idle fleet publishes nothing')
        await manager.stop()
    })
    it('starts IDLE when the fleet requires fleet_serial and a bot has none, naming the bots', async () => {
        // Reachable only for a row registered BEFORE remi got the flag: remi refuses such a
        // registration now. The whole fleet parks rather than driving the mapped bots, because the
        // unmapped one would address `0002` — the id minus the prefix — which is nobody's robot.
        let builtBots = 0
        const bus = createEventBus()
        const warnings: string[] = []
        bus.on('log', (l) => {
            if (l.level === 'warn') warnings.push(l.message)
        })
        const dir = mkdtempSync(join(tmpdir(), 'efk-'))
        dirs.push(dir)
        const manager = createFleetManager({
            remi: fakeRemi({
                getFleetConfig: async () => ({ ok: true, data: { ...config, requires_fleet_serial: true } }),
                listFleetBots: async () => ({
                    ok: true,
                    data: [{ ...mirror('ACME-0001'), fleet_serial: 'SN-0001' }, mirror('ACME-0002')],
                }),
            }),
            transportFor: () => new FakeTransport(),
            driverFor: (botId) => {
                builtBots += 1
                throw new Error(`driverFor must not be called while a bot is unmapped (${botId})`)
            },
            fleet: { supportsCommandInterrupt: true },
            env: { transport: 'mqtt' },
            bus,
            seq: createSeq(createStateStore(join(dir, '.efk-state.json')), { setTimer: (fn, ms) => setTimeout(fn, ms).unref() }),
            now: new FakeClock().now,
            tickMs: 0,
            rosterRefreshMs: 0,
        })

        const result = await manager.start()
        assert.deepEqual(result, { ok: true, roster: [] }, 'idle, not a failure')
        assert.equal(builtBots, 0, 'not even the mapped bot is built: partial success is the failure mode')
        const idle = warnings.filter((w) => w.startsWith('idle:'))
        assert.equal(idle.length, 1, 'said once')
        assert.match(idle[0] ?? '', /ACME-0002/, 'names the offending bot so it can be fixed')
        assert.doesNotMatch(idle[0] ?? '', /ACME-0001/, 'does not blame the bot that is fine')
        await manager.stop()
    })
    it('drives normally when every bot of a mapping-required fleet has its fleet_serial', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'efk-'))
        dirs.push(dir)
        const manager = createFleetManager({
            remi: fakeRemi({
                getFleetConfig: async () => ({ ok: true, data: { ...config, requires_fleet_serial: true } }),
                listFleetBots: async () => ({ ok: true, data: [{ ...mirror('ACME-0001'), fleet_serial: 'SN-0001' }] }),
            }),
            transportFor: () => new FakeTransport(),
            driverFor: (botId, fleetSerial) => {
                assert.equal(fleetSerial, 'SN-0001', 'the mapping reaches the driver factory')
                return new FakeDriver(botId)
            },
            fleet: { supportsCommandInterrupt: true },
            env: { transport: 'mqtt' },
            bus: createEventBus(),
            seq: createSeq(createStateStore(join(dir, '.efk-state.json')), { setTimer: (fn, ms) => setTimeout(fn, ms).unref() }),
            now: new FakeClock().now,
            tickMs: 0,
            rosterRefreshMs: 0,
        })
        const result = await manager.start()
        assert.deepEqual(result, { ok: true, roster: ['ACME-0001'] })
        await manager.stop()
    })
    it('starts IDLE when the driver is not configured, even with a full roster, and never builds a bot', async () => {
        // THE NORMAL CASE, not an edge one. Ops registers the bots in remi web on the day of the
        // onboarding; the partner's API credentials arrive when the partner sends them. In between,
        // the roster is full and there is nothing to talk to. This used to throw once per bot out of
        // `driverFor`. If it ever throws again, this test is what fails.
        let sentCapabilities = false
        let builtBots = 0
        const bus = createEventBus()
        const warnings: string[] = []
        bus.on('log', (l) => {
            if (l.level === 'warn') warnings.push(l.message)
        })
        const dir = mkdtempSync(join(tmpdir(), 'efk-'))
        dirs.push(dir)
        const manager = createFleetManager({
            remi: fakeRemi({
                setCapabilities: async (caps) => {
                    sentCapabilities = true
                    return { ok: true, data: caps }
                },
            }),
            transportFor: () => new FakeTransport(),
            driverFor: (botId) => {
                builtBots += 1
                throw new Error(`driverFor must not be called while the driver is unavailable (${botId})`)
            },
            driverUnavailable: () => 'the credentials are not configured (ACME_API_KEY: required)',
            fleet: { supportsCommandInterrupt: true },
            env: { transport: 'mqtt' },
            bus,
            seq: createSeq(createStateStore(join(dir, '.efk-state.json')), { setTimer: (fn, ms) => setTimeout(fn, ms).unref() }),
            now: new FakeClock().now,
            tickMs: 0,
            rosterRefreshMs: 0,
        })

        const result = await manager.start()
        assert.deepEqual(result, { ok: true, roster: [] }, 'idle, not a failure')
        assert.equal(builtBots, 0, 'not one driver is built: the credentials outrank the roster')
        assert.deepEqual(manager.bots(), [])
        assert.equal(sentCapabilities, false, 'no runtimes, no capabilities document: the empty one is worse than none')
        const idle = warnings.filter((w) => w.startsWith('idle:'))
        assert.equal(idle.length, 1, 'said once')
        const [message] = idle
        assert.ok(message?.includes('ACME_API_KEY'), 'names the missing variable')
        assert.ok(message?.includes('3 bot(s) are registered and waiting'), 'and how many bots are waiting')
        await manager.tickOnce()
        await manager.stop()
    })

    it('builds the fleet normally once the driver reports itself available', async () => {
        // The reverse path: `unavailable` answering null must leave the existing behaviour untouched.
        const { manager, drivers } = harness()
        const result = await manager.start()
        assert.deepEqual(result, { ok: true, roster: ['ACME-0001', 'ACME-0002'] })
        assert.equal(drivers.size, 2)
        await manager.stop()
    })

    it('refuses to start when remi expects the other transport', async () => {
        const { manager } = harness(fakeRemi({ getFleetConfig: async () => ({ ok: true, data: { ...config, transport: 'http' } }) }))
        const result = await manager.start()
        assert.equal(result.ok === false && result.reason, 'transport_mismatch')
    })
    it('surfaces a remi error with its code', async () => {
        const { manager } = harness(
            fakeRemi({ getFleetConfig: async () => ({ ok: false, status: 404, code: 'FLEET_NOT_CONFIGURED', message: '' }) }),
        )
        const result = await manager.start()
        assert.equal(result.ok === false && result.detail.includes('FLEET_NOT_CONFIGURED'), true)
    })
    it('puts per-bot capability differences in overrides', async () => {
        const { manager, drivers } = harness()
        // The first driver defines `default`; make the second differ, then read the pure getter.
        await manager.start()
        const second = drivers.get('ACME-0002')
        assert.ok(second)
        second.caps = { has_door: false, supported_commands: ['navigate_to', 'cancel_navigation'] }
        assert.deepEqual(manager.capabilities().overrides, {
            'ACME-0002': { has_door: false, supported_commands: ['navigate_to', 'cancel_navigation'] },
        })
    })
    it('the manager sends capabilities to remi once at start', async () => {
        const sent: unknown[] = []
        const remi = fakeRemi({
            setCapabilities: async (caps) => {
                sent.push(caps)
                return { ok: true as const, data: caps }
            },
        })
        const { manager } = harness(remi)
        await manager.start()
        assert.equal(sent.length, 1, 'exactly one send at start-up, not one per bot')
    })
    it('a failed capabilities send does not stop the fleet from starting', async () => {
        const remi = fakeRemi({
            setCapabilities: async () => ({ ok: false as const, status: 503, code: 'UNAVAILABLE', message: 'down' }),
        })
        const { manager } = harness(remi)
        const started = await manager.start()
        assert.equal(started.ok, true, 'a fleet with no capabilities on file runs on the default behaviour')
    })
    it('a start that fails builds no fleet, so a retry does not stack a second one', async () => {
        let badDriver = true
        const { manager, transport } = harness(fakeRemi(), createEventBus(), (botId) => (badDriver && botId === 'ACME-0002' ? 2 : 1))
        const first = await manager.start()
        assert.equal(first.ok === false && first.reason, 'driver_version')
        assert.deepEqual(manager.bots(), [], 'a start that answered ok: false reports no fleet')
        assert.equal(manager.driver('ACME-0001'), undefined, 'not even the bot it got as far as building')
        assert.equal(manager.config(), null, 'and the cached config follows the fleet: there is nothing to describe')
        assert.equal(transport.started.length, 0, 'the transport was never started')

        badDriver = false
        const second = await manager.start()
        assert.deepEqual(second, { ok: true, roster: ['ACME-0001', 'ACME-0002'] }, 'the retry builds exactly one fleet, not one and a half')
        assert.deepEqual(
            manager.bots().map((b) => b.botId),
            ['ACME-0001', 'ACME-0002'],
        )
        assert.deepEqual(transport.started, ['ACME-0001', 'ACME-0002'])
        assert.equal(manager.config()?.namespace, 'acme')
    })
    it('a tick publishes each due state through the transport and closes the tick once', async () => {
        const { manager, transport } = harness()
        await manager.start()
        await manager.tickOnce()
        assert.equal(transport.states.length, 2)
        assert.deepEqual(
            transport.states.map((s) => s.bot_id),
            ['ACME-0001', 'ACME-0002'],
        )
        assert.equal(transport.flushes, 1, 'one batch boundary per tick, not one per bot')
    })
    it('state.published only fires when the transport says the state left', async () => {
        const bus = createEventBus()
        const published: string[] = []
        bus.on('state.published', (e) => published.push(e.botId))
        const { manager, transport, clock } = harness(fakeRemi(), bus)
        transport.delivers = false
        await manager.start()
        await manager.tickOnce()
        assert.deepEqual(published, [], 'a disconnected fleet must not look like a healthy one')
        transport.delivers = true
        // The refused tick spent its turn (BotRuntime charges the attempt, delivered or not), so the
        // next one is due at the idle heartbeat.
        clock.advance(IDLE_HEARTBEAT_MS)
        await manager.tickOnce()
        assert.deepEqual(published.sort(), ['ACME-0001', 'ACME-0002'])
    })
    it('stop() drops the bus subscriptions, so a stopped fleet stops forwarding events', async () => {
        const bus = createEventBus()
        const { manager, transport } = harness(fakeRemi(), bus)
        await manager.start()
        await manager.stop()
        let delivered = 0
        transport.publishEvent = async () => {
            delivered += 1
            return true
        }
        bus.emit('event.emitted', {
            botId: 'ACME-0001',
            event: { bot_id: 'ACME-0001', type: 'unblocked', occurred_at: new Date().toISOString() },
            delivered: false,
        })
        assert.equal(delivered, 0)
    })
    it('a dropped terminal reaches the bus: the bound on unpublished outcomes is never silent', async () => {
        const { manager, transport, warnings } = harness()
        transport.delivers = false // nothing is ever confirmed, so the queue only grows
        await manager.start()
        assert.ok(transport.handler, 'the manager wires the command door')
        for (let i = 0; i < MAX_UNPUBLISHED_TERMINALS + 1; i += 1) {
            await transport.handler('ACME-0001', expired(`J/${i}`))
        }
        assert.deepEqual(
            warnings.filter((w) => w.startsWith('dropped')),
            [`dropped the outcome of J/0: ${MAX_UNPUBLISHED_TERMINALS} still waiting to be published`],
        )
        assert.equal(manager.bots()[0]?.currentCommand()?.id, 'J/1', 'the oldest went, the rest are still queued')
    })
    it('serve() drains the ledger in HTTP polling mode, where nothing is ever published', async () => {
        const bus = createEventBus()
        const served: string[] = []
        bus.on('state.served', (e) => served.push(e.botId))
        const { manager, transport } = harness(fakeRemi(), bus)
        transport.delivers = false // HTTP without push: remi polls, the transport publishes nothing
        await manager.start()
        assert.ok(transport.handler)
        await transport.handler('ACME-0001', expired('J/a'))
        await transport.handler('ACME-0001', expired('J/b'))
        const runtime = manager.bots()[0]
        assert.equal(runtime?.currentCommand()?.id, 'J/a')
        await manager.tickOnce()
        assert.equal(runtime?.currentCommand()?.id, 'J/a', 'a refused publish drains nothing')

        const answer = manager.serve()
        assert.deepEqual(
            answer.map((s) => s.botId),
            ['ACME-0001', 'ACME-0002'],
        )
        assert.equal(answer[0]?.stale, false)
        assert.equal(answer[0]?.state.current_command?.id, 'J/a', 'the poll carries the outcome remi is waiting for')
        assert.equal('seq' in (answer[0]?.state ?? {}), false, 'a poll consumes no counter, so it carries no seq')
        assert.deepEqual(served, ['ACME-0001', 'ACME-0002'])
        assert.equal(runtime?.currentCommand()?.id, 'J/b', 'answering GET /bots drained the head: the queue moves on')
    })
    it('serve() hands back the stale fallback without acknowledging it, so an outcome that never left stays queued', async () => {
        const { manager, transport, drivers } = harness()
        transport.delivers = false // HTTP polling: the poll is the only delivery there is
        await manager.start()
        assert.ok(transport.handler)
        const runtime = manager.bots()[0]
        assert.ok(runtime)
        const driver = drivers.get('ACME-0001')
        assert.ok(driver)

        // J/a is queued and then really delivered by a poll, so the queue empties behind it.
        await transport.handler('ACME-0001', expired('J/a'))
        manager.serve()
        assert.equal(runtime.currentCommand()?.id, 'J/a')

        // J/b is queued and offered to the transport, which refuses it. remi has NOT seen this
        // outcome — and the state carrying it is now the bot's last good snapshot.
        await transport.handler('ACME-0001', expired('J/b'))
        await manager.tickOnce()
        assert.equal(runtime.currentCommand()?.id, 'J/b', 'a refused publish leaves the outcome queued')

        driver.snap = { ...driver.snap, position: null }
        const answer = manager.serve()
        assert.equal(answer[0]?.stale, true, 'the bot stays in the list, served from its last good state')
        assert.equal(answer[0]?.state.current_command?.id, 'J/b', 'the fallback is a snapshot of an older moment')

        // The proof that the fallback was served and NOT acknowledged: J/b must still be queued, and
        // the queue outranks the live command in the single slot. Acknowledging the fallback would
        // have popped J/b for a state that never left the process, and remi would never learn how
        // the command it issued ended.
        driver.snap = { ...driver.snap, position: { lat: 33.97, lng: -118.41 } }
        await transport.handler('ACME-0001', live('J/c'))
        assert.equal(runtime.currentCommand()?.id, 'J/b', 'the outcome remi never received still owns the slot, ahead of the live command')
    })
})

/**
 * ORDERLY SHUTDOWN. `stop()` used to clear the interval and walk on to
 * `seq.flush()` without waiting for a tick that had already started. A QoS 1 publish still waiting
 * for its PUBACK — or an HTTP batch still inside `flushTick` — confirms a moment later and consumes
 * a `seq` AFTER the counters have been written, so that increment never reaches `.efk-state.json`.
 * The next run then hands that bot a number it has already used, and remi discards every state it
 * is sent, silently, until the counter climbs back past where it was.
 */
describe('fleet manager shutdown', () => {
    it('waits for the publish already in flight before flushing the seq counters', async () => {
        const order: string[] = []
        let counter = 0
        const seq: Seq = {
            next: () => {
                order.push('seq.next')
                counter += 1
                return counter
            },
            peek: () => counter,
            flush: () => order.push('seq.flush'),
        }

        let entered = 0
        // Definite assignment: the executor runs synchronously, but TS's control flow cannot see
        // that and would narrow a `| null` binding to `never` at the call below.
        let release!: () => void
        const inFlight = new Promise<void>((resolve) => {
            release = resolve
        })
        const transport: Transport = {
            kind: 'mqtt',
            setBots: async () => {},
            start: async () => {},
            stop: async () => {},
            publishState: async () => {
                entered += 1
                await inFlight
                return true
            },
            publishEvent: async () => true,
            flushTick: async () => {},
            onCommand: () => {},
        }

        const clock = new FakeClock()
        const manager = createFleetManager({
            remi: fakeRemi({ listFleetBots: async () => ({ ok: true, data: [mirror('ACME-0001')] }) }),
            transportFor: () => transport,
            driverFor: (botId) => new FakeDriver(botId),
            fleet: { supportsCommandInterrupt: true },
            env: { transport: 'mqtt' },
            bus: createEventBus(),
            seq,
            now: clock.now,
            tickMs: 5,
            rosterRefreshMs: 0,
        })
        await manager.start()

        // Bounded: node's default test timeout is Infinity, so a regression here must fail, not hang.
        const deadline = Date.now() + 5_000
        while (entered === 0) {
            if (Date.now() > deadline) throw new Error('no tick ever reached the transport')
            await new Promise((resolve) => setTimeout(resolve, 2))
        }
        assert.deepEqual(order, [], 'nothing consumed or flushed while the publish is still in flight')

        const stopping = manager.stop()
        // Let `stop()` get as far as it can with the publish still pending. If it did not await the
        // tick, this is where it would flush.
        await new Promise((resolve) => setTimeout(resolve, 20))
        assert.deepEqual(order, [], 'stop() must not have flushed anything yet')

        release()
        await stopping
        assert.deepEqual(order, ['seq.next', 'seq.flush'], 'the counter is consumed first, and the flush that follows carries it to disk')
    })
})

/**
 * The roster loop. What every one of these asserts, in the end, is the same promise: a change made in
 * remi reaches this process without anybody restarting it — the way it would reach a partner running
 * their own implementation of the contract, who never had our roster frozen in the first place.
 */
describe('roster refresh', () => {
    const rows = (...ids: Array<[string, string | null]>) => ids.map(([bot_id, fleet_serial]) => ({ ...mirror(bot_id), fleet_serial }))

    /** A remi whose roster is whatever the test last assigned, so a pass can see a different fleet. */
    function movingRemi(initial: ReturnType<typeof rows>, fleet: Partial<FleetConfigResponse> = {}) {
        const state = { roster: initial, capabilities: 0, down: false }
        const remi = fakeRemi({
            getFleetConfig: async () =>
                state.down
                    ? ({ ok: false, status: 503, code: 'UNAVAILABLE', message: 'remi is down' } as const)
                    : ({ ok: true, data: { ...config, ...fleet } } as const),
            listFleetBots: async () => ({ ok: true, data: state.roster }),
            setCapabilities: async (caps) => {
                state.capabilities += 1
                return { ok: true, data: caps }
            },
        })
        return { remi, state }
    }

    it('drives a bot registered after the fleet came up idle, with no restart', async () => {
        const { remi, state } = movingRemi([])
        const h = harness(remi)
        assert.equal((await h.manager.start()).ok, true)
        assert.deepEqual(h.manager.bots(), [], 'an empty roster starts idle')
        // Nothing to describe, so nothing is registered: an empty capabilities document would tell
        // remi these robots have no door and take no commands.
        assert.equal(state.capabilities, 0)

        state.roster = rows(['ACME-0001', null])
        await h.manager.reconcileOnce()

        assert.deepEqual(
            h.manager.bots().map((b) => b.botId),
            ['ACME-0001'],
        )
        assert.deepEqual(h.transport.started, ['ACME-0001'], 'the transport serves the fleet as it is now')
        assert.equal(state.capabilities, 1, 'a fleet that now has a bot registers what it can do')
        await h.manager.stop()
    })

    it('stops driving a bot that left the roster, and releases its driver', async () => {
        const { remi, state } = movingRemi(rows(['ACME-0001', null], ['ACME-0002', null]))
        const h = harness(remi)
        await h.manager.start()

        state.roster = rows(['ACME-0001', null])
        await h.manager.reconcileOnce()

        assert.deepEqual(
            h.manager.bots().map((b) => b.botId),
            ['ACME-0001'],
        )
        assert.deepEqual(h.stopped, ['ACME-0002'], 'the driver is stopped, not merely forgotten')
        assert.equal(h.manager.driver('ACME-0002'), undefined)
        await h.manager.stop()
    })

    it('rebuilds a remapped bot against its new serial, and leaves its neighbour alone', async () => {
        const { remi, state } = movingRemi(rows(['ACME-0001', 'ROBOT-A'], ['ACME-0002', 'ROBOT-B']))
        const h = harness(remi)
        await h.manager.start()
        const neighbour = h.manager.bots().find((b) => b.botId === 'ACME-0002')

        state.roster = rows(['ACME-0001', 'ROBOT-C'], ['ACME-0002', 'ROBOT-B'])
        await h.manager.reconcileOnce()

        assert.deepEqual(h.built.at(-1), { botId: 'ACME-0001', fleetSerial: 'ROBOT-C' })
        assert.deepEqual(h.stopped, ['ACME-0001'], 'only the remapped bot is torn down')
        assert.equal(
            h.manager.bots().find((b) => b.botId === 'ACME-0002'),
            neighbour,
            'the untouched bot keeps its runtime, and with it its ledger',
        )
        await h.manager.stop()
    })

    it('does not rebuild a bot that is running a command, and picks it up once it is free', async () => {
        const { remi, state } = movingRemi(rows(['ACME-0001', 'ROBOT-A']))
        const h = harness(remi)
        await h.manager.start()
        const before = h.manager.bots()[0]
        assert.ok(h.transport.handler)
        await h.transport.handler('ACME-0001', live('cmd-1'))

        state.roster = rows(['ACME-0001', 'ROBOT-C'])
        await h.manager.reconcileOnce()

        assert.equal(h.manager.bots()[0], before, 'the mission in flight outranks the remap')
        assert.deepEqual(h.stopped, [])
        assert.ok(
            h.warnings.some((w) => w.includes('deferred') && w.includes('ACME-0001')),
            `expected a deferral warning, got ${JSON.stringify(h.warnings)}`,
        )

        // The command finishes; the next pass applies the change that was waiting.
        await h.transport.handler('ACME-0001', {
            id: 'cmd-2',
            type: 'cancel_navigation',
            issued_at: new Date(1_799_999_000_000).toISOString(),
        })
        await h.manager.reconcileOnce()
        assert.deepEqual(h.built.at(-1), { botId: 'ACME-0001', fleetSerial: 'ROBOT-C' })
        await h.manager.stop()
    })

    it('skips an unmapped bot instead of parking the fleet that is already driving', async () => {
        const { remi, state } = movingRemi(rows(['ACME-0001', 'ROBOT-A']), { requires_fleet_serial: true })
        const h = harness(remi)
        await h.manager.start()

        state.roster = rows(['ACME-0001', 'ROBOT-A'], ['ACME-0002', null])
        await h.manager.reconcileOnce()

        assert.deepEqual(
            h.manager.bots().map((b) => b.botId),
            ['ACME-0001'],
            'the mapped robot keeps driving; only the bad row is left out',
        )
        assert.deepEqual(h.stopped, [])
        await h.manager.stop()
    })

    it('keeps driving the roster it has when remi cannot be reached', async () => {
        const { remi, state } = movingRemi(rows(['ACME-0001', null]))
        const h = harness(remi)
        await h.manager.start()
        const before = h.manager.bots()[0]

        // remi goes down AND the roster it would have answered is empty: a refresh that took the
        // failure at face value would take the whole fleet off the road.
        state.down = true
        state.roster = []
        await h.manager.reconcileOnce()

        assert.equal(h.manager.bots()[0], before)
        assert.deepEqual(h.stopped, [])
        assert.ok(
            h.warnings.some((w) => w.includes('roster refresh skipped')),
            `expected a skip warning, got ${JSON.stringify(h.warnings)}`,
        )
        await h.manager.stop()
    })

    it('registers capabilities once while they do not change', async () => {
        const { remi, state } = movingRemi(rows(['ACME-0001', null]))
        const h = harness(remi)
        await h.manager.start()
        assert.equal(state.capabilities, 1)

        await h.manager.reconcileOnce()
        await h.manager.reconcileOnce()
        assert.equal(state.capabilities, 1, 'an unchanged document is not sent again every pass')
        await h.manager.stop()
    })
})
