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

    it('never waits longer than the cap, jitter included', () => {
        // The jitter must not push the wait OVER the ceiling the contract states: at the cap the
        // spread is 48 s – 60 s, not 48 s – 72 s.
        assert.equal(
            nextBackoffMs(10, () => 1),
            60_000,
        )
        assert.equal(
            nextBackoffMs(10, () => 0),
            48_000,
        )
        for (let attempt = 0; attempt <= 40; attempt += 1) {
            for (const roll of [0, 0.25, 0.5, 0.75, 1]) {
                const wait = nextBackoffMs(attempt, () => roll)
                assert.ok(wait <= 60_000, `attempt ${attempt} with roll ${roll} waited ${wait} ms`)
                assert.ok(wait >= 800, `attempt ${attempt} with roll ${roll} waited ${wait} ms, which is a tight loop`)
            }
        }
    })
})
