import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { expectations, readSample, runParityInProcess, sampleNames } from './parity-runner'

describe('frozen samples validate against the vendored schemas', () => {
    it('every sample file has an expectation and every expectation has a file', () => {
        const files = sampleNames().sort()
        assert.deepEqual(files, Object.keys(expectations).sort())
    })

    for (const [name, schema] of Object.entries(expectations)) {
        it(name, () => {
            const result = schema.safeParse(readSample(name))
            assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues, null, 2))
        })
    }

    it('the whole parity check, the same call `efk check` C8 makes, is green', async () => {
        const result = await runParityInProcess()
        assert.equal(result.ok, true, result.detail)
    })

    /**
     * The runner REPORTS a mis-synced clone; it does not throw one. It used to read every declared
     * expectation with `readSample`, so an expectation naming a file that is not on disk came out as
     * an ENOENT — and its only caller in the product is `efk check` C8, the first command a partner
     * runs. C8 wraps the call as a belt, but the fix belongs here: the next caller would have
     * crashed exactly as this one did. (`readSample` itself still throws, deliberately: a missing
     * file must fail the per-sample test above, loudly.)
     */
    it('an expectation naming a sample that is not on disk is REPORTED, not thrown', async () => {
        const ghost = 'handmade__this-sample-does-not-exist'
        expectations[ghost] = z.unknown()
        try {
            const result = await runParityInProcess()
            assert.equal(result.ok, false)
            assert.match(result.detail, new RegExp(`${ghost}: the expectation names a sample that is not readable`))
        } finally {
            delete expectations[ghost]
        }
        assert.equal((await runParityInProcess()).ok, true, 'the sabotage is undone and the real check is green again')
    })
})
