import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { serve } from '@hono/node-server'
import type { BotState, FleetCapabilities } from '../../contract/schemas'
import type { BotRuntime } from '../../core/bot-runtime'
import { createEventBus } from '../../core/events'
import { FakeClock, FakeDriver } from '../../core/fakes'
import { createFleetManager, type FleetManager, type ServedState } from '../../core/fleet-manager'
import { createSeq } from '../../core/seq'
import { createStateStore } from '../../core/state-store'
import type { RemiClient } from '../../remi/client'
import { createHttpTransport } from './index'

const dirs: string[] = []
const managers: FleetManager[] = []
after(async () => {
    for (const manager of managers) await manager.stop()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const TOKEN = 'a'.repeat(32)
const auth = { authorization: `Bearer ${TOKEN}` }

const stateOf = (botId: string): BotState => ({
    bot_id: botId,
    timestamp: new Date(1_800_000_000_000).toISOString(),
    available: true,
    connected: true,
    position: { lat: 1, lng: 2 },
    battery: { percentage: 50 },
    door: 'closed',
    current_command: null,
})

/** A runtime that only has to answer for its id, count its touches and record what it was told landed. */
function stubRuntime(botId: string) {
    let touches = 0
    const confirmed: BotState[] = []
    const runtime = {
        botId,
        touch: () => {
            touches += 1
        },
        confirmPublished: (state: BotState) => {
            confirmed.push(state)
            return true
        },
    } as unknown as BotRuntime
    return { runtime, touches: () => touches, confirmed }
}

/** Stands in for `@hono/node-server`: captures the app's fetch so the surface is exercised without a port. */
function fakeServer() {
    const captured: { fetch: ((request: Request) => Response | Promise<Response>) | null; closes: number } = { fetch: null, closes: 0 }
    const listen = (options: { fetch: (request: Request) => Response | Promise<Response> }) => {
        captured.fetch = options.fetch
        return {
            close: (callback?: () => void) => {
                captured.closes += 1
                callback?.()
            },
        }
    }
    const request = async (path: string) => {
        if (!captured.fetch) throw new Error('the transport never started a server')
        return await captured.fetch(new Request(`http://127.0.0.1:4300${path}`, { headers: auth }))
    }
    return { listen: listen as unknown as typeof serve, request, closes: () => captured.closes }
}

const remiThat = (pushState: RemiClient['pushState']): RemiClient => ({ pushState }) as unknown as RemiClient

const command = (id: string) => ({ id, type: 'navigate_to' as const, params: { lat: 1, lng: 2 }, issued_at: new Date().toISOString() })

/**
 * A real fleet, a real HTTP transport with push on, and a remi that can be taken away. This is where
 * the deferred acknowledgement is visible end to end: the `seq` a state carries and the outcome in
 * its `current_command` only move on when a batch has really been taken.
 */
async function pushHarness() {
    const dir = mkdtempSync(join(tmpdir(), 'efk-'))
    dirs.push(dir)
    const clock = new FakeClock()
    const driver = new FakeDriver('ACME-0001')
    const bus = createEventBus()
    const server = fakeServer()
    /** Every attempt, landed or not — the refused ones are what the failure paths are read from. */
    const attempts: BotState[][] = []
    const published: BotState[] = []
    bus.on('state.published', (e) => published.push(e.state))
    let reachable = true
    const remi = {
        getFleetConfig: async () => ({
            ok: true,
            data: {
                namespace: 'acme',
                bot_id_prefix: 'ACME-',
                transport: 'http' as const,
                base_url: null,
                token_set: true,
                poll_interval_active_ms: 2000,
                poll_interval_idle_ms: 15000,
                max_bots: 2,
                contract_version: '2026-09',
            },
        }),
        listFleetBots: async () => ({
            ok: true,
            data: [
                {
                    bot_id: 'ACME-0001',
                    location_id: 'L',
                    assignable: false,
                    blocked_by: ['disconnected' as const],
                    state_age_ms: null,
                    current_job_id: null,
                },
            ],
        }),
        pushState: async (states: BotState[]) => {
            attempts.push(states)
            return reachable
                ? { ok: true as const, data: { accepted: states.length, rejected: 0 } }
                : { ok: false as const, status: 404, code: 'BOT_NOT_FOUND', message: 'no such fleet' }
        },
        setCapabilities: async (caps: FleetCapabilities) => ({ ok: true as const, data: caps }),
    } as unknown as RemiClient
    const manager = createFleetManager({
        remi,
        transportFor: () =>
            createHttpTransport({
                port: 4300,
                token: TOKEN,
                bus,
                push: true,
                remi,
                serveFleet: () => manager.serve(),
                serve: server.listen,
            }),
        driverFor: () => driver,
        fleet: { supportsCommandInterrupt: true },
        env: { transport: 'http' },
        bus,
        seq: createSeq(createStateStore(join(dir, '.efk-state.json'))),
        now: clock.now,
        tickMs: 0,
        rosterRefreshMs: 0,
    })
    const started = await manager.start()
    assert.equal(started.ok, true)
    managers.push(manager)
    const [runtime] = manager.bots()
    assert.ok(runtime)
    return {
        manager,
        runtime,
        driver,
        clock,
        attempts,
        published,
        takeRemiAway: () => {
            reachable = false
        },
    }
}

describe('HTTP transport', () => {
    it('answers GET /bots from the fleet manager serve(), the only path that drains the ledger', async () => {
        const server = fakeServer()
        let serves = 0
        const served: ServedState[] = [{ botId: 'ACME-0001', state: stateOf('ACME-0001'), stale: false }]
        const transport = createHttpTransport({
            port: 4300,
            token: TOKEN,
            bus: createEventBus(),
            push: false,
            serveFleet: () => {
                serves += 1
                return served
            },
            serve: server.listen,
        })
        await transport.start([stubRuntime('ACME-0001').runtime])
        const body = (await (await server.request('/bots')).json()) as { bots: Array<{ bot_id: string }> }
        assert.equal(serves, 1, 'the poll goes through serve(); assembling from the runtimes would never acknowledge anything')
        assert.deepEqual(
            body.bots.map((b) => b.bot_id),
            ['ACME-0001'],
        )
        await transport.stop()
    })

    it('without push nothing is published: remi polls, so publishState says so instead of lying', async () => {
        const server = fakeServer()
        const transport = createHttpTransport({
            port: 4300,
            token: TOKEN,
            bus: createEventBus(),
            push: false,
            serveFleet: () => [],
            serve: server.listen,
        })
        await transport.start([stubRuntime('ACME-0001').runtime])
        assert.equal(await transport.publishState('ACME-0001', stateOf('ACME-0001')), false)
        await transport.flushTick()
        await transport.stop()
    })

    it('says once that events have nowhere to go without push, instead of dropping them in silence', async () => {
        const server = fakeServer()
        const bus = createEventBus()
        const warnings: string[] = []
        bus.on('log', (l) => warnings.push(`${l.level}: ${l.message}`))
        const transport = createHttpTransport({ port: 4300, token: TOKEN, bus, push: false, serveFleet: () => [], serve: server.listen })
        await transport.start([stubRuntime('ACME-0001').runtime])
        const event = { bot_id: 'ACME-0001', type: 'unblocked' as const, occurred_at: new Date().toISOString() }
        assert.equal(await transport.publishEvent('ACME-0001', event), false)
        assert.equal(await transport.publishEvent('ACME-0001', event), false)
        const dropped = warnings.filter((w) => w.includes('has no events channel'))
        assert.equal(dropped.length, 1, 'said once per run: a warning per event would bury the log')
        assert.match(dropped.join(''), /HTTP_PUSH=true/)
        await transport.stop()
    })

    it('with push the tick goes out as ONE request at flushTick, and only then counts as published', async () => {
        const server = fakeServer()
        const bus = createEventBus()
        const published: string[] = []
        bus.on('state.published', (e) => published.push(e.botId))
        const batches: number[] = []
        const first = stubRuntime('ACME-0001')
        const second = stubRuntime('ACME-0002')
        const transport = createHttpTransport({
            port: 4300,
            token: TOKEN,
            bus,
            push: true,
            remi: remiThat(async (states) => {
                batches.push(states.length)
                return { ok: true, data: { accepted: states.length, rejected: 0 } }
            }),
            serveFleet: () => [],
            serve: server.listen,
        })
        await transport.start([first.runtime, second.runtime])
        assert.equal(
            await transport.publishState('ACME-0001', stateOf('ACME-0001')),
            false,
            'buffered is not delivered: a true here would spend the seq and drain the ledger for bytes still sitting in this process',
        )
        await transport.publishState('ACME-0002', stateOf('ACME-0002'))
        assert.deepEqual(batches, [], 'nothing leaves until the manager closes the tick')
        assert.deepEqual(first.confirmed, [], 'and nothing is confirmed either')
        await transport.flushTick()
        assert.deepEqual(batches, [2])
        assert.equal(first.confirmed.length, 1)
        assert.equal(second.confirmed.length, 1)
        assert.deepEqual(published, ['ACME-0001', 'ACME-0002'], 'the transport emits it, because publishState truthfully said false')
        await transport.flushTick()
        assert.deepEqual(batches, [2], 'an empty batch is not a request')
        await transport.stop()
    })

    it('a batch remi refuses confirms nothing: the outcomes it carried stay owed', async () => {
        const server = fakeServer()
        const bus = createEventBus()
        const published: string[] = []
        bus.on('state.published', (e) => published.push(e.botId))
        const bot = stubRuntime('ACME-0001')
        const transport = createHttpTransport({
            port: 4300,
            token: TOKEN,
            bus,
            push: true,
            remi: remiThat(async () => ({ ok: false, status: 404, code: 'BOT_NOT_FOUND', message: 'no such fleet' })),
            serveFleet: () => [],
            serve: server.listen,
        })
        await transport.start([bot.runtime])
        await transport.publishState('ACME-0001', stateOf('ACME-0001'))
        await transport.flushTick()
        assert.deepEqual(bot.confirmed, [], 'nothing reached remi, so nothing may be marked published')
        assert.deepEqual(published, [])
        await transport.stop()
    })

    it('a batch skipped because a previous push is still in flight is never confirmed', async () => {
        const server = fakeServer()
        let release = () => {}
        const inFlight = new Promise<void>((resolve) => {
            release = resolve
        })
        const superseded = stateOf('ACME-0001')
        const bot = stubRuntime('ACME-0001')
        const transport = createHttpTransport({
            port: 4300,
            token: TOKEN,
            bus: createEventBus(),
            push: true,
            remi: remiThat(async (states) => {
                await inFlight
                return { ok: true, data: { accepted: states.length, rejected: 0 } }
            }),
            serveFleet: () => [],
            serve: server.listen,
        })
        await transport.start([bot.runtime])
        await transport.publishState('ACME-0001', stateOf('ACME-0001'))
        const flying = transport.flushTick()
        await transport.publishState('ACME-0001', superseded)
        await transport.flushTick() // skipped: a push is still in flight
        assert.deepEqual(bot.confirmed, [], 'the skipped batch never left, so it is not confirmed either')
        release()
        await flying
        assert.equal(bot.confirmed.length, 1, 'only the batch that really landed')
        assert.notEqual(bot.confirmed[0], superseded, 'and not the one that was superseded and dropped')
        await transport.stop()
    })

    it('stop() drops a batch that never got its flush, unconfirmed and out loud', async () => {
        const server = fakeServer()
        const bus = createEventBus()
        const warnings: string[] = []
        bus.on('log', (l) => warnings.push(l.message))
        const bot = stubRuntime('ACME-0001')
        const transport = createHttpTransport({
            port: 4300,
            token: TOKEN,
            bus,
            push: true,
            remi: remiThat(async (states) => ({ ok: true, data: { accepted: states.length, rejected: 0 } })),
            serveFleet: () => [],
            serve: server.listen,
        })
        await transport.start([bot.runtime])
        await transport.publishState('ACME-0001', stateOf('ACME-0001'))
        await transport.stop()
        assert.deepEqual(bot.confirmed, [], 'a shutdown must not mark as delivered what it is throwing away')
        assert.match(warnings.join('\n'), /1 state\(s\) still waiting for a flush/)
    })

    it('touches every bot when push starts landing again, instead of leaving remi on the 15 s heartbeat', async () => {
        const server = fakeServer()
        const bus = createEventBus()
        const logs: string[] = []
        bus.on('log', (l) => logs.push(l.message))
        // A 4xx, so the client answers at once: this test must never wait out a real backoff.
        let reachable = false
        const first = stubRuntime('ACME-0001')
        const second = stubRuntime('ACME-0002')
        const transport = createHttpTransport({
            port: 4300,
            token: TOKEN,
            bus,
            push: true,
            remi: remiThat(async (states) =>
                reachable
                    ? { ok: true, data: { accepted: states.length, rejected: 0 } }
                    : { ok: false, status: 404, code: 'BOT_NOT_FOUND', message: 'no such fleet' },
            ),
            serveFleet: () => [],
            serve: server.listen,
        })
        await transport.start([first.runtime, second.runtime])
        await transport.publishState('ACME-0001', stateOf('ACME-0001'))
        await transport.flushTick()
        assert.equal(first.touches(), 0, 'a failure is not a recovery')
        reachable = true
        await transport.publishState('ACME-0001', stateOf('ACME-0001'))
        await transport.flushTick()
        assert.equal(first.touches(), 1)
        assert.equal(second.touches(), 1, 'the whole fleet is stale, not just the bot that was in the batch')
        await transport.publishState('ACME-0001', stateOf('ACME-0001'))
        await transport.flushTick()
        assert.equal(first.touches(), 1, 'a healthy tick is not a recovery either')
        assert.match(logs.join('\n'), /landing again/)
        await transport.stop()
    })

    it('stop() closes the server once, and a second stop is a no-op', async () => {
        const server = fakeServer()
        const transport = createHttpTransport({
            port: 4300,
            token: TOKEN,
            bus: createEventBus(),
            push: false,
            serveFleet: () => [],
            serve: server.listen,
        })
        await transport.start([])
        await transport.stop()
        await transport.stop()
        assert.equal(server.closes(), 1)
    })

    it('a delivered batch is what spends the seq and drains the ledger, end to end', async () => {
        const { manager, runtime, driver, attempts, published } = await pushHarness()
        driver.accept = { kind: 'rejected', code: 'BOT_BUSY', message: 'busy' }
        await runtime.handleCommand(command('J/one'), 'http')
        await manager.tickOnce()
        await runtime.handleCommand(command('J/two'), 'http')
        await manager.tickOnce()
        assert.deepEqual(
            attempts.flat().map((state) => [state.seq, state.current_command?.id]),
            [
                [1, 'J/one'],
                [2, 'J/two'],
            ],
            'the counter advanced and the queue head moved on, because the first batch really landed',
        )
        assert.equal(published.length, 2)
    })

    it('a push remi never takes spends no seq and strands no outcome: the same state goes out again', async () => {
        const { manager, runtime, driver, clock, attempts, published, takeRemiAway } = await pushHarness()
        takeRemiAway()
        driver.accept = { kind: 'rejected', code: 'BOT_BUSY', message: 'busy' }
        await runtime.handleCommand(command('J/one'), 'http')
        await runtime.handleCommand(command('J/two'), 'http')
        await manager.tickOnce()
        clock.advance(15_000) // the idle heartbeat, so the second tick is due
        await manager.tickOnce()
        assert.equal(attempts.length, 2)
        // Acknowledging on the way into the batch would have read [1, 'J/one'] then [2, 'J/two']:
        // a counter spent on bytes that never left, and an outcome remi is owed dropped off the queue.
        assert.deepEqual(
            attempts.flat().map((state) => [state.seq, state.current_command?.id]),
            [
                [1, 'J/one'],
                [1, 'J/one'],
            ],
        )
        assert.deepEqual(published, [])
    })
})
