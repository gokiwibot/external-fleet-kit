import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { botScenarioFor, mergeScenario, overrideIdsNotIn, parseScenario } from './scenario'

describe('mergeScenario', () => {
    it('the override wins leaf by leaf and never removes a sibling, at any depth', () => {
        const merged = mergeScenario(
            { battery: { startPct: 90, drainPctPerKm: 7 }, motion: { speedMps: 3, noise: { lateralM: 5, speedJitter: 0.4 } } },
            { motion: { noise: { lateralM: 0 } } },
        )
        assert.deepEqual(merged, {
            battery: { startPct: 90, drainPctPerKm: 7 },
            motion: { speedMps: 3, noise: { lateralM: 0, speedJitter: 0.4 } },
        })
    })
    it('replaces arrays whole instead of merging them element by element', () => {
        assert.deepEqual(mergeScenario({ noise: { stopSecs: [3, 15] } }, { noise: { stopSecs: [1, 2] } }), { noise: { stopSecs: [1, 2] } })
    })
})

describe('scenario', () => {
    it('{} is the default scenario', () => {
        const s = parseScenario({})
        const b = botScenarioFor(s, 'ACME-0001')
        assert.equal(b.motion.speedMps, 1.5)
        assert.equal(b.door.mode, 'full')
        assert.equal(b.battery.startPct, 100)
        assert.equal(s.fleet.origin, null)
    })
    it('an override keeps every sibling of the default, including ones that are NOT the schema default', () => {
        // Every value here differs from the schema default on purpose: a test written with default
        // values passes even when the merge throws the `default` block away entirely.
        const s = parseScenario({
            default: { battery: { startPct: 90 }, door: { transitionMs: 3_500 }, motion: { noise: { speedJitter: 0.4 } } },
            overrides: { 'ACME-0002': { door: { mode: 'boolean' }, motion: { noise: { lateralM: 0 } } } },
        })
        const b = botScenarioFor(s, 'ACME-0002')
        assert.equal(b.battery.startPct, 90, 'a whole block the override never mentions is kept')
        assert.equal(b.door.mode, 'boolean')
        assert.equal(
            b.door.transitionMs,
            3_500,
            'the sibling inside the overridden block is the DEFAULT block value, not the schema default',
        )
        assert.equal(b.motion.noise.lateralM, 0)
        assert.equal(b.motion.noise.speedJitter, 0.4, 'the sibling two levels down is kept too')
        const other = botScenarioFor(s, 'ACME-0001')
        assert.equal(other.door.mode, 'full')
        assert.equal(other.door.transitionMs, 3_500)
    })
    it('rejects out-of-range values', () => {
        assert.throws(() => parseScenario({ default: { motion: { speedMps: 99 } } }))
    })
    it('a misspelled knob fails with its path instead of being dropped', () => {
        assert.throws(
            () => parseScenario({ default: { battery: { startPercent: 15 } } }),
            (error: unknown) => JSON.stringify(error).includes('startPercent'),
        )
        assert.throws(() => parseScenario({ default: { motion: { noise: { lateralMeters: 1 } } } }))
        assert.throws(() => parseScenario({ overrides: { 'ACME-0001': { batttery: { startPct: 10 } } } }))
    })
    it('names override keys that are not in the roster', () => {
        const s = parseScenario({ overrides: { 'ACME-0001': { available: false }, 'OLD-0009': { available: false } } })
        assert.deepEqual(overrideIdsNotIn(s, ['ACME-0001', 'ACME-0002']), ['OLD-0009'])
    })
})
