import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nextBackoffMs } from './backoff'

describe('backoff', () => {
    it('doubles from 1 s, caps at 60 s, jitters ±20 %', () => {
        assert.equal(
            nextBackoffMs(0, () => 0.5),
            1_000,
        )
        assert.equal(
            nextBackoffMs(1, () => 0.5),
            2_000,
        )
        assert.equal(
            nextBackoffMs(5, () => 0.5),
            32_000,
        )
        assert.equal(
            nextBackoffMs(10, () => 0.5),
            60_000,
        )
        assert.equal(
            nextBackoffMs(0, () => 0),
            800,
        )
        assert.equal(
            nextBackoffMs(0, () => 1),
            1_200,
        )
    })
})
