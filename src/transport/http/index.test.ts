import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { serve } from '@hono/node-server'
import type { BotState } from '../../contract/schemas'
import type { BotRuntime } from '../../core/bot-runtime'
import { createEventBus } from '../../core/events'
import type { ServedState } from '../../core/fleet-manager'
import type { RemiClient } from '../../remi/client'
import { createHttpTransport } from './index'

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

/** A runtime that only has to answer for its id and count the touches a recovery owes it. */
function stubRuntime(botId: string) {
    let touches = 0
    const runtime = {
        botId,
        touch: () => {
            touches += 1
        },
    } as unknown as BotRuntime
    return { runtime, touches: () => touches }
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
        assert.equal(
            await transport.publishEvent('ACME-0001', { bot_id: 'ACME-0001', type: 'unblocked', occurred_at: new Date().toISOString() }),
            false,
        )
        await transport.flushTick()
        await transport.stop()
    })

    it('with push the tick goes out as ONE request at flushTick, not one per bot', async () => {
        const server = fakeServer()
        const batches: number[] = []
        const transport = createHttpTransport({
            port: 4300,
            token: TOKEN,
            bus: createEventBus(),
            push: true,
            remi: remiThat(async (states) => {
                batches.push(states.length)
                return { ok: true, data: { accepted: states.length, rejected: 0 } }
            }),
            serveFleet: () => [],
            serve: server.listen,
        })
        await transport.start([stubRuntime('ACME-0001').runtime, stubRuntime('ACME-0002').runtime])
        assert.equal(await transport.publishState('ACME-0001', stateOf('ACME-0001')), true)
        assert.equal(await transport.publishState('ACME-0002', stateOf('ACME-0002')), true)
        assert.deepEqual(batches, [], 'nothing leaves until the manager closes the tick')
        await transport.flushTick()
        assert.deepEqual(batches, [2])
        await transport.flushTick()
        assert.deepEqual(batches, [2], 'an empty batch is not a request')
        await transport.stop()
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
})
