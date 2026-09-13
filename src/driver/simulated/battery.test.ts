import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createBattery } from './battery'
import { botScenarioSchema } from './scenario'

describe('battery', () => {
    it('drains per km travelled', () => {
        const b = createBattery(botScenarioSchema.parse({ battery: { startPct: 100, drainPctPerKm: 2 } }).battery)
        b.advance(500, 250, true)
        assert.equal(b.percentage(), 99)
        b.advance(2_000, 250, true)
        assert.equal(b.percentage(), 95)
    })
    it('never goes below 0 and reports integers', () => {
        const b = createBattery(botScenarioSchema.parse({ battery: { startPct: 1, drainPctPerKm: 50 } }).battery)
        b.advance(5_000, 250, true)
        assert.equal(b.percentage(), 0)
    })
    it('recharges per minute when idle, and NOT while dwelling mid-route', () => {
        const b = createBattery(botScenarioSchema.parse({ battery: { startPct: 50, rechargePctPerMin: 10 } }).battery)
        b.advance(0, 60_000, false)
        assert.equal(b.percentage(), 60)
        b.advance(0, 60_000, true)
        assert.equal(b.percentage(), 60, 'stopped at a light with a navigation running is not charging')
        b.advance(0, 600_000, false)
        assert.equal(b.percentage(), 100)
    })
    it('unavailable below the configured threshold, and 0 means never', () => {
        const spec = botScenarioSchema.parse({ battery: { startPct: 31, drainPctPerKm: 1, unavailableBelowPct: 30 } }).battery
        const b = createBattery(spec)
        assert.equal(b.unavailable(), false)
        b.advance(2_000, 250, true)
        assert.equal(b.percentage(), 29)
        assert.equal(b.unavailable(), true)
        const off = createBattery(botScenarioSchema.parse({ battery: { startPct: 5 } }).battery)
        assert.equal(off.unavailable(), false)
    })
    it('the threshold boundary itself is on the AVAILABLE side: exactly at it is not unavailable, only strictly below it is', () => {
        const spec = botScenarioSchema.parse({ battery: { startPct: 32, drainPctPerKm: 1, unavailableBelowPct: 30 } }).battery
        const b = createBattery(spec)
        b.advance(2_000, 250, true)
        assert.equal(b.percentage(), 30)
        assert.equal(b.unavailable(), false, 'exactly at the threshold: "unavailable BELOW" does not include equal')
        b.advance(1_000, 250, true)
        assert.equal(b.percentage(), 29)
        assert.equal(b.unavailable(), true, 'one point past the threshold: now strictly below it')
    })
})
