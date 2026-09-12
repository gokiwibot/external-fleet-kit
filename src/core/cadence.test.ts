import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCadence, IDLE_HEARTBEAT_MS, MOVING_INTERVAL_MS } from './cadence'

describe('cadence (contract note on POST /state)', () => {
    const cadence = createCadence()
    const cases: Array<[string, Parameters<typeof cadence.shouldPublish>[0], boolean]> = [
        ['never published → publish', { nowMs: 0, lastPublishedAtMs: null, moving: false, changed: false }, true],
        ['never published, moving → publish', { nowMs: 0, lastPublishedAtMs: null, moving: true, changed: false }, true],
        ['idle, 14 s since last → wait', { nowMs: 14_000, lastPublishedAtMs: 0, moving: false, changed: false }, false],
        ['idle, 1 ms short of 15 s → wait', { nowMs: IDLE_HEARTBEAT_MS - 1, lastPublishedAtMs: 0, moving: false, changed: false }, false],
        ['idle, 15 s since last → heartbeat', { nowMs: IDLE_HEARTBEAT_MS, lastPublishedAtMs: 0, moving: false, changed: false }, true],
        ['idle, 1 ms past 15 s → heartbeat', { nowMs: IDLE_HEARTBEAT_MS + 1, lastPublishedAtMs: 0, moving: false, changed: false }, true],
        ['moving, 900 ms since last → wait', { nowMs: 900, lastPublishedAtMs: 0, moving: true, changed: false }, false],
        ['moving, 1 ms short of 1 s → wait', { nowMs: MOVING_INTERVAL_MS - 1, lastPublishedAtMs: 0, moving: true, changed: false }, false],
        ['moving, 1 s since last → publish', { nowMs: MOVING_INTERVAL_MS, lastPublishedAtMs: 0, moving: true, changed: false }, true],
        ['moving, 1 ms past 1 s → publish', { nowMs: MOVING_INTERVAL_MS + 1, lastPublishedAtMs: 0, moving: true, changed: false }, true],
        [
            'stopped, position change but under 1 s and under 15 s → wait (no change, no deadline reached)',
            { nowMs: 500, lastPublishedAtMs: 0, moving: false, changed: false },
            false,
        ],
        [
            'something changed 250 ms ago → publish now (within 1 s)',
            { nowMs: 250, lastPublishedAtMs: 0, moving: false, changed: true },
            true,
        ],
        [
            'changed on the very next tick (250 ms) while moving → publish',
            { nowMs: 250, lastPublishedAtMs: 0, moving: true, changed: true },
            true,
        ],
        [
            'changed at the same instant as last publish (0 ms elapsed) → publish',
            { nowMs: 0, lastPublishedAtMs: 0, moving: false, changed: true },
            true,
        ],
        [
            'changed exactly on the idle-heartbeat tick → still publish because of the change, not the heartbeat',
            { nowMs: IDLE_HEARTBEAT_MS, lastPublishedAtMs: 0, moving: false, changed: true },
            true,
        ],
    ]
    for (const [name, input, expected] of cases) {
        it(name, () => assert.equal(cadence.shouldPublish(input), expected))
    }
})

describe('cadence with a custom config', () => {
    it('honors an injected movingIntervalMs / idleHeartbeatMs instead of the defaults', () => {
        const cadence = createCadence({ movingIntervalMs: 2_000, idleHeartbeatMs: 5_000 })
        assert.equal(cadence.shouldPublish({ nowMs: 1_000, lastPublishedAtMs: 0, moving: true, changed: false }), false)
        assert.equal(cadence.shouldPublish({ nowMs: 2_000, lastPublishedAtMs: 0, moving: true, changed: false }), true)
        assert.equal(cadence.shouldPublish({ nowMs: 4_999, lastPublishedAtMs: 0, moving: false, changed: false }), false)
        assert.equal(cadence.shouldPublish({ nowMs: 5_000, lastPublishedAtMs: 0, moving: false, changed: false }), true)
    })
})
