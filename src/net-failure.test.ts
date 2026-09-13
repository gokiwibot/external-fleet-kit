/**
 * Every test here starts from an exception node REALLY threw, captured in the test itself. A test
 * built from an invented message proves nothing about what node actually puts in its errors, and
 * that gap is exactly what let the leak below live in the plan's own code until it was measured.
 *
 * Nothing reaches the network: the only host is a CLOSED port on 127.0.0.1.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeFetchFailure, safeOrigin } from './net-failure'

/** A closed port that is still a legal HTTP port — node rejects port 1 as "bad port" before connecting. */
const CLOSED = 45_999

/** Runs the real `fetch` and hands back whatever it really threw. */
async function realThrow(url: string, init?: RequestInit): Promise<unknown> {
    try {
        await fetch(url, { signal: AbortSignal.timeout(5_000), ...init })
    } catch (error) {
        return error
    }
    throw new Error(`expected fetch(${url}) to throw`)
}

describe('describeFetchFailure, against exceptions node really threw', () => {
    /**
     * THE MEASURED LEAK. node's `fetch` refuses a URL with userinfo and quotes THE WHOLE URL —
     * password included — in the message. `remi/client.ts` used to return that message as its
     * `NETWORK` result, and `efk check` C2 prints it, so a `REMI_API_URL` with credentials in it put
     * the password on screen and into the support email a partner pastes it into.
     */
    it('never lets a URL with credentials in it out of the exception it was quoted in', async () => {
        const error = await realThrow(`https://fleet-user:supersecret@127.0.0.1:${CLOSED}/api/v3/fleet`)
        assert.match((error as Error).message, /supersecret/, 'precondition: node really does quote the password')

        const described = describeFetchFailure(error)
        assert.ok(!described.includes('supersecret'), `the password must not survive: ${described}`)
        assert.ok(!described.includes('fleet-user'), 'nor the user half of it')
        assert.ok(!described.includes('127.0.0.1'), 'nor the URL it was embedded in')
        assert.match(described, /take the credentials out of it/, 'while still naming the fix')
    })

    it('describes a refused connection from the code, not from the message', async () => {
        const error = await realThrow(`http://127.0.0.1:${CLOSED}/api/v3/fleet`)
        assert.equal((error as Error).message, 'fetch failed', 'precondition: the raw message says nothing useful')
        assert.equal(describeFetchFailure(error), 'the host refused the connection (ECONNREFUSED)')
    })

    it('describes a name that does not resolve', async () => {
        const error = await realThrow('https://efk-nothing-resolves-here.invalid/api/v3/fleet')
        const described = describeFetchFailure(error)
        assert.match(described, /did not resolve \((ENOTFOUND|EAI_AGAIN)\)/)
        assert.ok(!described.includes('efk-nothing-resolves-here'), 'the host is the caller`s to name, not the exception`s')
    })

    it('names a deadline only when the caller set one', () => {
        const timedOut = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        assert.equal(describeFetchFailure(timedOut), 'the request timed out')
        assert.equal(describeFetchFailure(timedOut, 5_000), 'no answer within 5 s')
    })

    it('quotes nothing at all from an exception it cannot classify', () => {
        const described = describeFetchFailure(new Error('TLS error for fleet_acme:hunter2@remi.internal'))
        assert.ok(!described.includes('hunter2'))
        assert.ok(!described.includes('remi.internal'))
        assert.equal(described, 'the request failed with no code this kit can safely quote')
    })
})

describe('safeOrigin', () => {
    it('drops the credentials a partner may have put in the URL', () => {
        assert.equal(safeOrigin('https://user:supersecret@fleet.acme.com:8443/v1/'), 'https://fleet.acme.com:8443')
        assert.equal(safeOrigin('https://remi.kiwi/api/v3/fleet'), 'https://remi.kiwi')
    })

    it('does not echo back something that is not a URL', () => {
        assert.equal(safeOrigin('user:supersecret@nonsense'), 'the configured URL')
        assert.ok(!safeOrigin('user:supersecret@nonsense').includes('supersecret'))
    })
})
