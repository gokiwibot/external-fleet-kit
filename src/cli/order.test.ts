import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RemiClient } from '../remi/client'
// An earlier version used `as Env` without importing the type. With `verbatimModuleSyntax`
// and `strict` that does not typecheck, so the test it belongs to could never have run.
import type { Env } from './env'
import { createOrder, watchOrder } from './order'

describe('efk order', () => {
    it('create uses the sandbox external ids, one package and the test tag', async () => {
        let body: unknown
        const remi = {
            // The brief wrote this as `((body = b), {…})`. Same semantics, same literals, but the
            // comma-assignment idiom is a biome error in this repo (lint/suspicious/noAssignInExpressions).
            createDelivery: async (b: unknown) => {
                body = b
                return { ok: true as const, data: { id: 'EK-1', state: 'pending', bot: null, arriving: null, pickup: {}, dropoff: {} } }
            },
        } as unknown as RemiClient
        const env = {
            SANDBOX_PICKUP_EXTERNAL_ID: 'efk-sandbox-pickup',
            SANDBOX_DROPOFF_EXTERNAL_ID: 'efk-sandbox-dropoff',
            SANDBOX_LOCATION_ID: 'V1StGXR8Z5jdHi6BmyT2q',
        } as Env
        const result = await createOrder(remi, env, 'efk test', () => 1_800_000_000_000)
        assert.equal(result.ok, true)
        assert.deepEqual(body, {
            name: 'efk test',
            external_id: 'efk-1800000000000',
            location_id: 'V1StGXR8Z5jdHi6BmyT2q',
            pickup: { external_id: 'efk-sandbox-pickup' },
            dropoff: { external_id: 'efk-sandbox-dropoff' },
            packages: [{ reference: 'efk-1', items: [{ name: 'efk test package', quantity: 1 }] }],
            tags: ['test', 'external-fleet-kit'],
        })
    })
    it('watch polls until a terminal state and reports each change', async () => {
        const states = ['pending', 'going_to_pickup', 'at_pickup', 'going_to_dropoff', 'delivered']
        let i = 0
        const remi = {
            getDelivery: async () => ({
                ok: true as const,
                data: {
                    id: 'EK-1',
                    state: states[Math.min(i++, states.length - 1)] as string,
                    bot: { id: 'ACME-0001' },
                    arriving: null,
                    pickup: {},
                    dropoff: {},
                },
            }),
        } as unknown as RemiClient
        const seen: string[] = []
        const outcome = await watchOrder(remi, 'EK-1', {
            intervalMs: 0,
            timeoutMs: 10_000,
            onState: (d) => seen.push(d.state),
            sleep: async () => {},
        })
        assert.equal(outcome, 'delivered')
        assert.deepEqual(seen, states)
    })

    /** Not in the brief: the two outcomes that are not "it worked", which nothing else covers. */
    it('watch reports error when remi refuses, and timeout when the clock runs out', async () => {
        const failing = {
            getDelivery: async () => ({ ok: false as const, status: 403, code: 'FORBIDDEN', message: 'no' }),
        } as unknown as RemiClient
        assert.equal(
            await watchOrder(failing, 'EK-1', { intervalMs: 0, timeoutMs: 10_000, onState: () => {}, sleep: async () => {} }),
            'error',
        )

        let clock = 0
        const pending = {
            getDelivery: async () => ({
                ok: true as const,
                data: { id: 'EK-1', state: 'pending', bot: null, arriving: null, pickup: {}, dropoff: {} },
            }),
        } as unknown as RemiClient
        const outcome = await watchOrder(pending, 'EK-1', {
            intervalMs: 0,
            timeoutMs: 1_000,
            onState: () => {},
            sleep: async () => {
                clock += 400
            },
            now: () => clock,
        })
        assert.equal(outcome, 'timeout')
    })
})
