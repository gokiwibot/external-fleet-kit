import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Position as Coords } from '../robot-driver'
import {
    advanceNoise,
    bearingBetween,
    dwellDurationMs,
    initialNoiseState,
    metersBetween,
    normaliseHeading,
    positionAt,
    prepareRoute,
    shouldDwell,
    stepRoute,
    straightRoute,
} from './motion'
import { noiseSchema } from './scenario'

/**
 * Movement is the part of this package worth testing, because it is the part that produces numbers
 * somebody will trust: the engine's ETAs are validated against a simulated bot walking the same
 * geometry, so a stepper that quietly loses distance would make those ETAs look correct.
 *
 * Randomness is INJECTED everywhere it is used, so every test below is deterministic. A test that
 * called `Math.random` would either be flaky or would have to assert nothing.
 */

/** A source of randomness that always returns the same value. `0.5` is the "no noise" midpoint. */
const fixed = (value: number) => () => value

/** Noise switched fully off, so a walk is exactly the distance it should be. */
const noNoise = noiseSchema.parse({ lateralM: 0, speedJitter: 0, stopRatePerKm: 0, headingNoiseDeg: 0 })

/** Roughly 100m apart, on the equator so a degree of longitude is a round number. */
const A: Coords = { lat: 0, lng: 0 }
const B: Coords = { lat: 0, lng: 0.001 }

describe('prepareRoute', () => {
    it('refuses a path that cannot be walked', () => {
        assert.equal(prepareRoute([]), null)
        assert.equal(prepareRoute([A]), null)
        // Two identical points is zero length, which means the bot is already there.
        assert.equal(prepareRoute([A, { ...A }]), null)
    })

    it('accumulates segment lengths from zero', () => {
        const route = prepareRoute([A, B, { lat: 0, lng: 0.002 }])
        assert.ok(route)
        assert.equal(route.cumulative.length, 3)
        assert.equal(route.cumulative[0], 0)
        assert.ok(Math.abs((route.cumulative[1] ?? 0) - metersBetween(A, B)) < 0.001)
        assert.ok(Math.abs(route.totalM - metersBetween(A, B) * 2) < 0.01)
    })
})

describe('positionAt', () => {
    it('returns the endpoints for the ends, and clamps outside the route', () => {
        const route = prepareRoute([A, B])
        assert.ok(route)

        assert.deepEqual(positionAt(route, 0).coords, A)
        // Clamping rather than throwing: a caller that over-advances is asking about the goal, and
        // answering "the goal" is more useful in a wheel than an exception.
        const past = positionAt(route, route.totalM * 10)
        assert.ok(metersBetween(past.coords, B) < 0.01)
    })

    it('lands halfway along a two-point route at half its length', () => {
        const route = prepareRoute([A, B])
        assert.ok(route)

        const middle = positionAt(route, route.totalM / 2)
        assert.ok(Math.abs(metersBetween(A, middle.coords) - route.totalM / 2) < 0.05)
    })

    it('finds the right segment on a many-point route', () => {
        const path = Array.from({ length: 11 }, (_, i) => ({ lat: 0, lng: i * 0.0001 }))
        const route = prepareRoute(path)
        assert.ok(route)

        // Distance into the fourth segment, so the search must return index 3 and not a neighbour.
        const target = (route.cumulative[3] ?? 0) + 1
        assert.equal(positionAt(route, target).segmentIndex, 3)
    })

    it('faces along the segment it is walking', () => {
        const route = prepareRoute([A, B])
        assert.ok(route)
        // Due east on the equator.
        assert.ok(Math.abs(positionAt(route, 10).heading - bearingBetween(A, B)) < 0.001)
    })
})

describe('stepRoute', () => {
    it('advances exactly speed × time with noise off', () => {
        const route = prepareRoute([A, B])
        assert.ok(route)

        const step = stepRoute({
            route,
            travelledM: 0,
            speedMps: 2,
            dtMs: 1_000,
            noise: noNoise,
            noiseState: initialNoiseState(),
            arrive: 'normal',
            random: fixed(0.5),
        })

        assert.equal(step.travelledM, 2)
        assert.equal(step.speedMps, 2)
        assert.equal(step.arrived, false)
        assert.equal(step.startDwellMs, null)
    })

    it('arrives once the whole route is walked, and reports zero speed doing nothing more', () => {
        const route = prepareRoute([A, B])
        assert.ok(route)

        const arriving = stepRoute({
            route,
            travelledM: route.totalM - 1,
            speedMps: 10,
            dtMs: 1_000,
            noise: noNoise,
            noiseState: initialNoiseState(),
            arrive: 'normal',
            random: fixed(0.5),
        })
        assert.equal(arriving.arrived, true)
        assert.equal(arriving.travelledM, route.totalM)

        // A tick after arrival makes no progress, so the published speed is zero. A bot that
        // reported a cruise speed while sitting on its goal would read as a bot that overshot.
        const after = stepRoute({
            route,
            travelledM: route.totalM,
            speedMps: 10,
            dtMs: 1_000,
            noise: noNoise,
            noiseState: initialNoiseState(),
            arrive: 'normal',
            random: fixed(0.5),
        })
        assert.equal(after.speedMps, 0)
    })

    it('never arrives under arrive: never, parking a meter short', () => {
        const route = prepareRoute([A, B])
        assert.ok(route)

        const step = stepRoute({
            route,
            travelledM: 0,
            speedMps: 1_000,
            dtMs: 1_000,
            noise: noNoise,
            noiseState: initialNoiseState(),
            arrive: 'never',
            random: fixed(0.5),
        })

        assert.equal(step.arrived, false)
        assert.ok(Math.abs(step.travelledM - (route.totalM - 1)) < 0.001)
    })

    it('stalls mid-route under arrive: stall, and then stops making progress', () => {
        const route = prepareRoute([A, B])
        assert.ok(route)

        const step = stepRoute({
            route,
            travelledM: 0,
            speedMps: 1_000,
            dtMs: 1_000,
            noise: noNoise,
            noiseState: initialNoiseState(),
            arrive: 'stall',
            random: fixed(0.5),
        })

        assert.equal(step.arrived, false)
        assert.ok(step.travelledM > 0)
        assert.ok(step.travelledM < route.totalM)

        const again = stepRoute({
            route,
            travelledM: step.travelledM,
            speedMps: 1_000,
            dtMs: 1_000,
            noise: noNoise,
            noiseState: initialNoiseState(),
            arrive: 'stall',
            random: fixed(0.5),
        })
        // Zero speed is what `bot.ts` reads to publish WAITING_FOR_RESOLUTION.
        assert.equal(again.speedMps, 0)
    })

    it('offsets laterally when GPS wander is on', () => {
        const route = prepareRoute([A, B])
        assert.ok(route)
        const noise = noiseSchema.parse({ lateralM: 5, speedJitter: 0, stopRatePerKm: 0, headingNoiseDeg: 0 })

        // 1.0 pushes the random walk to its positive bound, so the offset is deterministic.
        const step = stepRoute({
            route,
            travelledM: 0,
            speedMps: 1,
            dtMs: 1_000,
            noise,
            noiseState: initialNoiseState(),
            arrive: 'normal',
            random: fixed(1),
        })

        const centreline = positionAt(route, step.travelledM).coords
        assert.ok(metersBetween(centreline, step.coords) > 0.1)
    })
})

describe('advanceNoise', () => {
    it('stays inside its configured envelope however long it walks', () => {
        const noise = noiseSchema.parse({ lateralM: 2, speedJitter: 0.2, headingNoiseDeg: 10 })
        let state = initialNoiseState()

        // An unbounded random walk over an hour would put the bot in the next street, so the bound
        // is the property that matters rather than the step size.
        for (let i = 0; i < 5_000; i += 1) {
            state = advanceNoise(state, noise, fixed(1))
        }

        assert.ok(Math.abs(state.lateralM) <= 2 + 1e-9)
        assert.ok(Math.abs(state.speedFactor - 1) <= 0.2 + 1e-9)
        assert.ok(Math.abs(state.headingOffsetDeg) <= 10 + 1e-9)
    })

    it('is a no-op when every noise figure is zero', () => {
        const state = advanceNoise(initialNoiseState(), noNoise, fixed(1))
        assert.deepEqual(state, { lateralM: 0, speedFactor: 1, headingOffsetDeg: 0 })
    })
})

describe('dwells', () => {
    it('scales with distance travelled, not with tick count', () => {
        // 2 stops per km means a 500m stretch has a probability of 1. This is what keeps the stop
        // rate a property of the route: halving the wheel interval must not double the stops.
        assert.equal(shouldDwell(500, 2, fixed(0.99)), true)
        assert.equal(shouldDwell(0.25, 2, fixed(0.99)), false)
        assert.equal(shouldDwell(1000, 0, fixed(0)), false)
    })

    it('lasts somewhere inside the configured window', () => {
        assert.equal(dwellDurationMs([3, 15], fixed(0)), 3_000)
        assert.equal(dwellDurationMs([3, 15], fixed(1)), 15_000)
        assert.equal(dwellDurationMs([15, 3], fixed(0)), 3_000)
    })
})

describe('straightRoute', () => {
    it('is a two-point route, which is what makes straight mode share the walker', () => {
        const route = straightRoute(A, B)
        assert.ok(route)
        assert.equal(route.path.length, 2)
        assert.ok(Math.abs(route.totalM - metersBetween(A, B)) < 0.001)
    })
})

describe('normaliseHeading', () => {
    it('wraps into 0-360, which is what the payload carries', () => {
        assert.equal(normaliseHeading(0), 0)
        assert.equal(normaliseHeading(-90), 270)
        assert.equal(normaliseHeading(450), 90)
    })
})
