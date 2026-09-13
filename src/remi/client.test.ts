import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BotState } from '../contract/schemas'
import { createRemiClient } from './client'

type Call = { url: string; init?: RequestInit }
function fakeFetch(routes: Record<string, (call: Call) => Response>) {
    const calls: Call[] = []
    const fetchFn: typeof fetch = async (input, init) => {
        const url = String(input)
        calls.push({ url, init })
        const path = new URL(url).pathname + new URL(url).search
        const handler = routes[path]
        if (!handler) return new Response(JSON.stringify({ type: 'about:blank', title: 'NOT_FOUND', status: 404 }), { status: 404 })
        return handler({ url, init })
    }
    return { fetchFn, calls }
}
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A minimal, valid BotState for a given index — only pushState's chunking cares about the count. */
function makeState(i: number): BotState {
    return {
        bot_id: `ACME-${String(i).padStart(4, '0')}`,
        timestamp: '2026-09-01T00:00:00.000Z',
        available: true,
        connected: true,
        position: { lat: 0, lng: 0 },
        battery: { percentage: 100 },
        door: 'closed',
        current_command: null,
    }
}

describe('remi client', () => {
    it('sends the bearer key and parses GET /api/v3/fleet', async () => {
        const { fetchFn, calls } = fakeFetch({
            '/api/v3/fleet': () =>
                json({
                    data: {
                        namespace: 'acme',
                        bot_id_prefix: 'ACME-',
                        transport: 'mqtt',
                        base_url: null,
                        token_set: false,
                        poll_interval_active_ms: 2000,
                        poll_interval_idle_ms: 15000,
                        max_bots: 40,
                        contract_version: '2026-09',
                    },
                }),
        })
        const client = createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'live_sk_x', fetch: fetchFn })
        const result = await client.getFleetConfig()
        assert.equal(result.ok, true)
        assert.equal(result.ok && result.data.max_bots, 40)
        const headers = calls[0]?.init?.headers as Record<string, string> | undefined
        assert.equal(headers?.authorization, 'Bearer live_sk_x')
    })
    it('maps a problem body to { status, code }, reading `code` and not `title`', async () => {
        const { fetchFn } = fakeFetch({
            '/api/v3/fleet': () =>
                json(
                    {
                        type: 'about:blank',
                        title: 'Not Found',
                        status: 404,
                        code: 'FLEET_NOT_CONFIGURED',
                        detail: 'Robot.com has not configured your fleet.',
                    },
                    404,
                ),
        })
        const result = await createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'k', fetch: fetchFn }).getFleetConfig()
        assert.deepEqual(result.ok ? null : { status: result.status, code: result.code }, { status: 404, code: 'FLEET_NOT_CONFIGURED' })
        assert.equal(result.ok ? '' : result.message, 'Robot.com has not configured your fleet.')
    })
    // R11: split from the brief's single "falls back to HTTP_<status> when the error body is not RFC
    // 7807" test — an unparseable body and a body that parses but isn't a problem document are two
    // different branches of `call()`, and only the first was actually reached by that test.
    it('maps an unparseable error body to NOT_JSON', async () => {
        const { fetchFn } = fakeFetch({ '/api/v3/fleet': () => new Response('<html>502</html>', { status: 502 }) })
        const result = await createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'k', fetch: fetchFn }).getFleetConfig()
        assert.equal(!result.ok && result.code, 'NOT_JSON')
    })
    it('falls back to HTTP_<status> when the error body parses as JSON but is not a problem document', async () => {
        const { fetchFn } = fakeFetch({ '/api/v3/fleet': () => json({ message: 'upstream is down' }, 502) })
        const result = await createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'k', fetch: fetchFn }).getFleetConfig()
        assert.equal(!result.ok && result.code, 'HTTP_502')
    })
    it('walks every page of GET /api/v3/fleet/bots', async () => {
        const bot = (id: string) => ({
            bot_id: id,
            location_id: 'L',
            assignable: true,
            blocked_by: [],
            state_age_ms: 100,
            current_job_id: null,
        })
        const { fetchFn, calls } = fakeFetch({
            '/api/v3/fleet/bots?limit=200': () => json({ data: [bot('ACME-0001')], next_cursor: 'c2' }),
            '/api/v3/fleet/bots?limit=200&cursor=c2': () => json({ data: [bot('ACME-0002')], next_cursor: null }),
        })
        const result = await createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'k', fetch: fetchFn }).listFleetBots()
        assert.equal(result.ok && result.data.length, 2)
        assert.equal(calls.length, 2)
    })
    it('stops instead of looping forever when next_cursor does not advance', async () => {
        const bot = (id: string) => ({
            bot_id: id,
            location_id: 'L',
            assignable: true,
            blocked_by: [],
            state_age_ms: 100,
            current_job_id: null,
        })
        const { fetchFn, calls } = fakeFetch({
            '/api/v3/fleet/bots?limit=200': () => json({ data: [bot('ACME-0001')], next_cursor: 'stuck' }),
            '/api/v3/fleet/bots?limit=200&cursor=stuck': () => json({ data: [bot('ACME-0002')], next_cursor: 'stuck' }),
        })
        const result = await createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'k', fetch: fetchFn }).listFleetBots()
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.code, 'STALLED_CURSOR')
        assert.equal(calls.length, 2, 'must stop after the repeated cursor, never re-request a third time')
    })
    it('accepts a field remi added that the kit does not know (loose towards remi)', async () => {
        const { fetchFn } = fakeFetch({
            '/api/v3/fleet': () =>
                json({
                    data: {
                        namespace: 'acme',
                        bot_id_prefix: 'ACME-',
                        transport: 'mqtt',
                        base_url: null,
                        token_set: false,
                        poll_interval_active_ms: 2000,
                        poll_interval_idle_ms: 15000,
                        max_bots: 40,
                        contract_version: '2026-09',
                        supports_teleop: true,
                    },
                }),
        })
        const result = await createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'k', fetch: fetchFn }).getFleetConfig()
        assert.equal(result.ok, true, 'an additive field in a remi response must not stop a partner fleet')
    })
    it('CONTRACT_MISMATCH is for a field that is missing or of the wrong type, not for an extra one', async () => {
        const { fetchFn } = fakeFetch({ '/api/v3/fleet': () => json({ data: { namespace: 'acme', transport: 'carrier-pigeon' } }) })
        const result = await createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'k', fetch: fetchFn }).getFleetConfig()
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.code, 'CONTRACT_MISMATCH')
    })
    it('createDelivery posts the real Delivery API body to /api/v3/delivery/ and returns id and state', async () => {
        const { fetchFn, calls } = fakeFetch({
            '/api/v3/delivery/': () =>
                json({ data: { id: 'EK-5867', state: 'pending', bot: null, arriving: null, pickup: {}, dropoff: {} } }, 201),
        })
        const client = createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'k', fetch: fetchFn })
        const result = await client.createDelivery({
            name: 'efk test',
            external_id: 'efk-1800000000000',
            location_id: 'V1StGXR8Z5jdHi6BmyT2q',
            pickup: { external_id: 'efk-sandbox-pickup' },
            dropoff: { external_id: 'efk-sandbox-dropoff' },
            packages: [{ reference: 'efk-1', items: [{ name: 'efk test package', quantity: 1 }] }],
            tags: ['test'],
        })
        assert.equal(result.ok && result.data.id, 'EK-5867')
        assert.equal(calls[0]?.init?.method, 'POST')
    })
    it('sends exactly 200 states in a single request at the boundary', async () => {
        const states = Array.from({ length: 200 }, (_, i) => makeState(i))
        let calls = 0
        const { fetchFn } = fakeFetch({
            '/api/v3/fleet/state': (call) => {
                calls += 1
                const body = JSON.parse(String(call.init?.body)) as { bots: unknown[] }
                assert.equal(body.bots.length, 200)
                return json({ data: { accepted: 200, rejected: 0 } })
            },
        })
        const result = await createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'k', fetch: fetchFn }).pushState(states)
        assert.equal(result.ok, true)
        assert.equal(result.ok && result.data.accepted, 200)
        assert.equal(calls, 1)
    })
    it('splits pushState into chunks of at most 200 states per request one over the boundary', async () => {
        const states = Array.from({ length: 201 }, (_, i) => makeState(i))
        const sizes: number[] = []
        const { fetchFn } = fakeFetch({
            '/api/v3/fleet/state': (call) => {
                const body = JSON.parse(String(call.init?.body)) as { bots: unknown[] }
                sizes.push(body.bots.length)
                return json({ data: { accepted: body.bots.length, rejected: 0 } })
            },
        })
        const result = await createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'k', fetch: fetchFn }).pushState(states)
        assert.equal(result.ok, true)
        assert.equal(result.ok && result.data.accepted, 201)
        assert.deepEqual(sizes, [200, 1])
    })
    it('a failing chunk stops the push and surfaces that failure, never a fabricated success', async () => {
        // 401 states -> three chunks of 200, 200, 1. The second chunk fails; the third must never be
        // sent, and the overall Result must be that failure, not a folded-in partial success.
        const states = Array.from({ length: 401 }, (_, i) => makeState(i))
        const sizes: number[] = []
        const { fetchFn } = fakeFetch({
            '/api/v3/fleet/state': (call) => {
                const body = JSON.parse(String(call.init?.body)) as { bots: unknown[] }
                sizes.push(body.bots.length)
                if (sizes.length === 2) {
                    return json(
                        { type: 'about:blank', title: 'Bad Gateway', status: 502, code: 'UPSTREAM_DOWN', detail: 'remi is unavailable' },
                        502,
                    )
                }
                return json({ data: { accepted: body.bots.length, rejected: 0 } })
            },
        })
        const result = await createRemiClient({ baseUrl: 'https://remi.kiwi', apiKey: 'k', fetch: fetchFn }).pushState(states)
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.code, 'UPSTREAM_DOWN')
        assert.deepEqual(sizes, [200, 200], 'the first chunk was sent, the third (after the failure) never was')
    })
})
