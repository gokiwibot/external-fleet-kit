import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
})
