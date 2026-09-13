import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createEventBus } from '../../core/events'
import { createPushClient } from './push'

describe('push client', () => {
    it('retries 5xx with backoff and stops on 4xx', async () => {
        let n = 0
        const logs: string[] = []
        const bus = createEventBus()
        bus.on('log', (l) => logs.push(l.message))
        const remi = {
            pushState: async () =>
                ++n < 3
                    ? { ok: false as const, status: 503, code: 'X', message: '' }
                    : { ok: true as const, data: { accepted: 1, rejected: 0 } },
            reportEvent: async () => ({ ok: false as const, status: 404, code: 'BOT_NOT_FOUND', message: '' }),
        }
        // biome-ignore lint/suspicious/noExplicitAny: partial client
        const push = createPushClient({ remi: remi as any, bus, sleep: async () => {}, random: () => 0.5 })
        await push.pushState([{} as never])
        assert.equal(n, 3)
        await push.pushEvent({ bot_id: 'ACME-0001', type: 'unblocked', occurred_at: new Date().toISOString() })
        assert.match(logs.join('\n'), /BOT_NOT_FOUND.*efk check/)
    })
    it('sends one request per 200 states, not one per state', async () => {
        const sizes: number[] = []
        const remi = {
            pushState: async (states: unknown[]) => {
                sizes.push(states.length)
                return { ok: true as const, data: { accepted: states.length, rejected: 0 } }
            },
        }
        // biome-ignore lint/suspicious/noExplicitAny: partial client
        const push = createPushClient({ remi: remi as any, bus: createEventBus(), sleep: async () => {}, random: () => 0.5 })
        await push.pushState(Array.from({ length: 450 }, () => ({}) as never))
        assert.deepEqual(sizes, [200, 200, 50])
    })
    it('skips a batch while the previous one is still in flight instead of stacking retries', async () => {
        // The gate is built BEFORE the fake client, so `release` has a call signature the flow
        // analysis can see: assigned only inside the executor, TypeScript narrows it to `null`.
        let release = () => {}
        const inFlight = new Promise<void>((resolve) => {
            release = resolve
        })
        let calls = 0
        const remi = {
            pushState: async () => {
                calls += 1
                await inFlight
                return { ok: true as const, data: { accepted: 1, rejected: 0 } }
            },
        }
        // biome-ignore lint/suspicious/noExplicitAny: partial client
        const push = createPushClient({ remi: remi as any, bus: createEventBus(), sleep: async () => {}, random: () => 0.5 })
        const first = push.pushState([{} as never])
        await push.pushState([{} as never])
        await push.pushState([{} as never])
        assert.equal(calls, 1, 'a state is superseded by the next one; queueing them serves nobody')
        release()
        await first
    })
    it('413 is reported with a remedy, not as an opaque failure', async () => {
        const logs: string[] = []
        const bus = createEventBus()
        bus.on('log', (l) => logs.push(l.message))
        const remi = { pushState: async () => ({ ok: false as const, status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'body too large' }) }
        // biome-ignore lint/suspicious/noExplicitAny: partial client
        await createPushClient({ remi: remi as any, bus, sleep: async () => {}, random: () => 0.5 }).pushState([{} as never])
        assert.match(logs.join('\n'), /too large for remi/)
    })
    it('reports whether the batch really reached remi: a skip and a give-up are both a no', async () => {
        let release = () => {}
        const inFlight = new Promise<void>((resolve) => {
            release = resolve
        })
        const remi = {
            pushState: async () => {
                await inFlight
                return { ok: true as const, data: { accepted: 1, rejected: 0 } }
            },
        }
        // biome-ignore lint/suspicious/noExplicitAny: partial client
        const push = createPushClient({ remi: remi as any, bus: createEventBus(), sleep: async () => {}, random: () => 0.5 })
        const first = push.pushState([{} as never])
        assert.equal(await push.pushState([{} as never]), false, 'skipped: those states never left the process')
        release()
        assert.equal(await first, true)
        // biome-ignore lint/suspicious/noExplicitAny: partial client
        const failing = { pushState: async () => ({ ok: false as const, status: 503, code: 'X', message: '' }) } as any
        const down = createPushClient({ remi: failing, bus: createEventBus(), sleep: async () => {}, random: () => 0.5 })
        assert.equal(await down.pushState([{} as never]), false, 'gave up after 5 attempts: nothing reached remi')
    })
})
