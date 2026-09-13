import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { BotCommand, BotState, FleetCapabilities } from '../contract/schemas'
import type { CommandOutcome } from '../core/events'
import type { RemiClient } from '../remi/client'
import type { Transport } from '../transport/transport'
import { IDLE_HEARTBEAT_MS } from './cadence'
import { MAX_UNPUBLISHED_TERMINALS } from './command-ledger'
import { createEventBus, type EventBus } from './events'
import { FakeClock, FakeDriver } from './fakes'
import { createFleetManager } from './fleet-manager'
import { createSeq } from './seq'
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
        ...overrides,
    }
}

class FakeTransport implements Transport {
    readonly kind = 'mqtt' as const
    states: BotState[] = []
    capabilities: FleetCapabilities | null = null
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
    async stop() {}
    async publishState(_botId: string, state: BotState) {
        if (!this.delivers) return false
        this.states.push(state)
        return true
    }
    async publishEvent() {
        return this.delivers
    }
    async publishCapabilities(doc: FleetCapabilities) {
        this.capabilities = doc
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
        driverFor: (botId) => {
            const d = new FakeDriver(botId)
            // `driverVersion` is the literal 1 on the fake; the start-time gate needs a test that can
            // make one bot answer something else.
            Object.assign(d, { driverVersion: driverVersionFor(botId) })
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
    })
    return { manager, transport, drivers, clock, warnings }
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

describe('fleet manager', () => {
    it('discovers the roster, caps it at max_bots, starts one driver per bot and publishes capabilities', async () => {
        const { manager, transport, drivers } = harness()
        const result = await manager.start()
        assert.deepEqual(result, { ok: true, roster: ['ACME-0001', 'ACME-0002'] })
        assert.deepEqual([...drivers.keys()], ['ACME-0001', 'ACME-0002'])
        assert.deepEqual(transport.started, ['ACME-0001', 'ACME-0002'])
        assert.equal(transport.capabilities?.supports_command_interrupt, true)
        assert.deepEqual(transport.capabilities?.default, {
            has_door: true,
            supported_commands: ['navigate_to', 'cancel_navigation', 'set_door'],
        })
        assert.equal(transport.namespaceSeen, 'acme', 'the transport is built with the namespace remi gave us, never an empty string')
        assert.equal(manager.driver('ACME-0001'), drivers.get('ACME-0001'))
        assert.equal(manager.driver('ACME-0009'), undefined)
        await manager.stop()
        assert.deepEqual(manager.bots(), [], 'stop() empties the runtimes: a second start must not stack a second fleet on top')
    })
    it('refuses to start on an empty roster', async () => {
        const { manager } = harness(fakeRemi({ listFleetBots: async () => ({ ok: true, data: [] }) }))
        const result = await manager.start()
        assert.equal(result.ok === false && result.reason, 'empty_roster')
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
        const { manager, transport, drivers } = harness()
        // The first driver defines `default`; make the second differ before start publishes.
        const original = drivers
        await manager.start()
        const second = original.get('ACME-0002')
        assert.ok(second)
        second.caps = { has_door: false, supported_commands: ['navigate_to', 'cancel_navigation'] }
        await manager.refreshCapabilities()
        assert.deepEqual(transport.capabilities?.overrides, {
            'ACME-0002': { has_door: false, supported_commands: ['navigate_to', 'cancel_navigation'] },
        })
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
