import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDestinations } from './destinations'
import { metersBetween } from './motion'
import { botScenarioSchema } from './scenario'

const origin = { lat: 0, lng: 0 }

describe('destinations', () => {
    it('with no grid and no threshold, everything is reachable as-is', () => {
        const d = createDestinations(botScenarioSchema.parse({}).destinations, origin)
        assert.deepEqual(d.resolve({ lat: 0.5, lng: 0.5 }), { kind: 'ok', corrected: { lat: 0.5, lng: 0.5 }, distanceM: 0 })
        assert.deepEqual(d.validate({ lat: 0.5, lng: 0.5 }), {
            reachable: true,
            corrected_position: { lat: 0.5, lng: 0.5 },
            correction_distance_m: 0,
        })
    })
    it('snaps to the grid and reports the distance (0.0002 ≈ 22 m cells)', () => {
        const d = createDestinations(botScenarioSchema.parse({ destinations: { snapGridDeg: 0.0002 } }).destinations, origin)
        const r = d.resolve({ lat: 0.00011, lng: 0 })
        assert.equal(r.kind, 'ok')
        if (r.kind !== 'ok') return
        assert.deepEqual(r.corrected, { lat: 0.0002, lng: 0 })
        assert.ok(r.distanceM > 9 && r.distanceM < 11, `got ${r.distanceM}`)
    })
    it('beyond the threshold from the ORIGIN it is unreachable, wherever the bot is', () => {
        const d = createDestinations(botScenarioSchema.parse({ destinations: { unreachableBeyondM: 300 } }).destinations, origin)
        const far = { lat: 1, lng: 1 }
        const r = d.resolve(far)
        assert.equal(r.kind, 'unreachable')
        assert.ok(r.kind === 'unreachable' && Math.abs(r.distanceM - (metersBetween(origin, far) - 300)) < 1)
        const v = d.validate(far)
        assert.equal(v.reachable, false)
        assert.equal(!v.reachable && v.reason, 'out_of_service_area')
    })
    it('the service area is checked AFTER the snap, because the node is where the robot stops', () => {
        // One degree of latitude ≈ 111 320 m, so a 0.001° grid is a cell of ≈ 111 m.
        // Requested 0.0024° ≈ 267 m (outside a 240 m area) snaps DOWN to 0.002° ≈ 223 m (inside).
        const inward = createDestinations(
            botScenarioSchema.parse({ destinations: { snapGridDeg: 0.001, unreachableBeyondM: 240 } }).destinations,
            origin,
        )
        const r = inward.resolve({ lat: 0.0024, lng: 0 })
        assert.equal(r.kind, 'ok', 'the grid node is inside the area, so the destination is reachable')
        assert.deepEqual(r.kind === 'ok' && r.corrected, { lat: 0.002, lng: 0 })
        // Pinned, not just `.kind`: this is the size of the snap, requested (0.0024°) to corrected (0.002°).
        assert.equal(r.kind === 'ok' && r.distanceM, 44.5, `got ${r.kind === 'ok' && r.distanceM}`)

        // And the reverse: 0.0026° ≈ 289 m (inside a 300 m area) snaps UP to 0.003° ≈ 334 m (outside).
        const outward = createDestinations(
            botScenarioSchema.parse({ destinations: { snapGridDeg: 0.001, unreachableBeyondM: 300 } }).destinations,
            origin,
        )
        const or = outward.resolve({ lat: 0.0026, lng: 0 })
        assert.equal(or.kind, 'unreachable')
        // Pinned: the basis is the CORRECTED point (≈ 333.6 m from origin), never the raw target
        // (≈ 289.1 m) — using the raw target here would report a NEGATIVE distance (≈ -10.9), which
        // the contract's `correction_distance_m: z.number().min(0)` forbids.
        assert.equal(or.kind === 'unreachable' && or.distanceM, 33.6, `got ${or.kind === 'unreachable' && or.distanceM}`)
        assert.ok(or.kind === 'unreachable' && or.distanceM >= 0, 'correction_distance_m must never be negative')
    })
    it('validate is idempotent: the SAME coordinate gives the same answer no matter where the bot is', () => {
        // The bot is not an input at all — that is the property under test, so it must be visible.
        // The same Destinations answers identically for two different fleet origins ONLY if the
        // origin is what it measures from; a bot-relative implementation would drift between calls.
        const spec = botScenarioSchema.parse({ destinations: { snapGridDeg: 0.0002, unreachableBeyondM: 300 } }).destinations
        const near = createDestinations(spec, origin)
        const target = { lat: 0.00011, lng: 0 }
        const first = near.validate(target)
        const second = near.validate(target)
        assert.deepEqual(first, second)
        // And a second instance built from the same origin, after a hypothetical restart, agrees.
        assert.deepEqual(createDestinations(spec, origin).validate(target), first)
        // A different origin is a different service area, and that IS allowed to differ.
        assert.notDeepEqual(createDestinations(spec, { lat: 1, lng: 1 }).validate(target), first)
    })
})
