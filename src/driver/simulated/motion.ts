/**
 * Ported verbatim from kiwi-platforms `packages/bot-sim/src/motion.ts` (origin/main, 2026-09), minus
 * `downsamplePath` (no long polylines here) and with the kit's own types. Pure: given a route, a
 * distance along it and a source of randomness, it returns the next position, heading and speed.
 * `straight` legs are two-point routes, so the kit has exactly one stepper and no routing service.
 */

import * as turf from '@turf/turf'
import type { Position as Coords } from '../robot-driver'
import type { Noise } from './scenario'

/** A route with its segment lengths precomputed. Built once per goal, read every tick. */
export type WalkableRoute = Readonly<{
    path: readonly Coords[]
    /** `cumulative[i]` is the distance from the start of the path to `path[i]`, in meters. */
    cumulative: readonly number[]
    totalM: number
}>

/** How far short of the goal `arrive: 'never'` parks, in meters. Close enough to look arrived. */
export const NEVER_ARRIVE_GAP_M = 1

/** Where `arrive: 'stall'` gives up, as a fraction of the route. Mid-route, visibly not at either end. */
export const STALL_FRACTION = 0.6

/** How fast the lateral wander and the speed factor drift, per tick. Tuned to read as drift. */
const LATERAL_DRIFT = 0.25
const SPEED_DRIFT = 0.12

/**
 * Precomputes segment lengths.
 *
 * Returns null for anything that cannot be walked (fewer than two points, or a degenerate path of
 * zero length), which the caller treats as "no active goal" rather than as an error. A zero
 * length route means the bot is already there.
 */
export function prepareRoute(path: readonly Coords[]): WalkableRoute | null {
    if (path.length < 2) return null

    const cumulative: number[] = [0]
    let total = 0
    for (let i = 1; i < path.length; i += 1) {
        const previous = path[i - 1]
        const current = path[i]
        if (!previous || !current) return null
        total += metersBetween(previous, current)
        cumulative.push(total)
    }

    if (!(total > 0)) return null
    return { path, cumulative, totalM: total }
}

/** A two-point route: what `motion.mode: 'straight'` walks, and the fallback when routing fails. */
export function straightRoute(from: Coords, to: Coords): WalkableRoute | null {
    return prepareRoute([from, to])
}

/** Great-circle distance in meters. */
export function metersBetween(from: Coords, to: Coords): number {
    return turf.distance(turf.point([from.lng, from.lat]), turf.point([to.lng, to.lat]), { units: 'meters' })
}

/** Bearing in degrees, 0 = north. */
export function bearingBetween(from: Coords, to: Coords): number {
    return turf.bearing(turf.point([from.lng, from.lat]), turf.point([to.lng, to.lat]))
}

/** Moves `from` by `meters` along `bearing`. */
export function offsetBy(from: Coords, meters: number, bearing: number): Coords {
    if (meters === 0) return from
    const point = turf.destination(turf.point([from.lng, from.lat]), meters / 1000, bearing)
    const [lng, lat] = point.geometry.coordinates
    if (lng === undefined || lat === undefined) return from
    return { lat, lng }
}

/** A position on the route: where it is, which way it faces, and which segment it sits on. */
export type RoutePosition = Readonly<{ coords: Coords; heading: number; segmentIndex: number }>

/**
 * Position at `travelledM` along the route.
 *
 * A binary search for the segment, then interpolation along it. Distances outside the route clamp
 * to its ends rather than throwing: a caller that over-advances is asking about the goal, and
 * answering "the goal" is more useful than an exception in the wheel.
 */
export function positionAt(route: WalkableRoute, travelledM: number): RoutePosition {
    const clamped = Math.min(Math.max(travelledM, 0), route.totalM)
    const segment = findSegment(route.cumulative, clamped)

    const from = route.path[segment]
    const to = route.path[segment + 1]
    if (!from || !to) {
        const last = route.path[route.path.length - 1] ?? { lat: 0, lng: 0 }
        return { coords: last, heading: 0, segmentIndex: Math.max(0, route.path.length - 2) }
    }

    const segmentStart = route.cumulative[segment] ?? 0
    const into = clamped - segmentStart
    const heading = bearingBetween(from, to)

    return { coords: into <= 0 ? from : offsetBy(from, into, heading), heading, segmentIndex: segment }
}

/** Index of the segment containing `distance`. Binary search; the last segment owns the endpoint. */
function findSegment(cumulative: readonly number[], distance: number): number {
    let low = 0
    let high = cumulative.length - 2
    while (low < high) {
        const mid = (low + high + 1) >> 1
        if ((cumulative[mid] ?? 0) <= distance) low = mid
        else high = mid - 1
    }
    return Math.max(0, low)
}

/** The carried half of the noise. Not persisted, for the reason the module doc gives. */
export type NoiseState = Readonly<{
    /** Current lateral offset from the route centreline, in meters. Signed. */
    lateralM: number
    /** Current multiplier on cruise speed. Drifts around 1. */
    speedFactor: number
    /** Current heading offset, in degrees. Signed. */
    headingOffsetDeg: number
}>

export function initialNoiseState(): NoiseState {
    return { lateralM: 0, speedFactor: 1, headingOffsetDeg: 0 }
}

/**
 * Advances the random walk one tick.
 *
 * Each component pulls a small random step and is then bounded, so it wanders inside its
 * configured envelope instead of escaping it: an unbounded walk over an hour puts a bot in the
 * next street.
 */
export function advanceNoise(state: NoiseState, noise: Noise, random: () => number): NoiseState {
    const lateral = drift(state.lateralM, noise.lateralM * LATERAL_DRIFT, noise.lateralM, random)
    const speed = drift(state.speedFactor - 1, noise.speedJitter * SPEED_DRIFT, noise.speedJitter, random) + 1
    const heading = drift(state.headingOffsetDeg, noise.headingNoiseDeg * LATERAL_DRIFT, noise.headingNoiseDeg, random)
    return { lateralM: lateral, speedFactor: speed, headingOffsetDeg: heading }
}

/** One bounded random-walk step: `value ± step`, clamped to ±bound. */
function drift(value: number, step: number, bound: number, random: () => number): number {
    if (bound <= 0) return 0
    const next = value + (random() * 2 - 1) * step
    return Math.min(Math.max(next, -bound), bound)
}

/**
 * Whether an unplanned dwell starts in the `distanceM` just travelled.
 *
 * Poisson along the route rather than per tick, so the stop rate is a property of the ROUTE and
 * not of the tick interval. Changing the wheel from 250ms to 100ms must not triple the number of
 * times a bot stops.
 */
export function shouldDwell(distanceM: number, stopRatePerKm: number, random: () => number): boolean {
    if (stopRatePerKm <= 0 || distanceM <= 0) return false
    return random() < (distanceM / 1000) * stopRatePerKm
}

/** How long one unplanned dwell lasts, in ms, uniform over `stopSecs`. */
export function dwellDurationMs(stopSecs: readonly [number, number], random: () => number): number {
    const [min, max] = stopSecs
    const low = Math.min(min, max)
    const high = Math.max(min, max)
    return Math.round((low + random() * (high - low)) * 1000)
}

export type StepInput = Readonly<{
    route: WalkableRoute
    travelledM: number
    /** Cruise speed before jitter, m/s. */
    speedMps: number
    dtMs: number
    noise: Noise
    noiseState: NoiseState
    arrive: 'normal' | 'never' | 'stall'
    random: () => number
}>

export type StepResult = Readonly<{
    travelledM: number
    coords: Coords
    heading: number
    /** The speed actually published this tick. Zero while dwelling or stalled. */
    speedMps: number
    arrived: boolean
    /** Set when this tick begins an unplanned dwell. The caller stores the deadline. */
    startDwellMs: number | null
    noiseState: NoiseState
}>

/**
 * One movement tick.
 *
 * The order matters: noise advances first (so the published position always carries the current
 * wander even on a tick that makes no progress), then the ceiling for this leg is applied, then
 * the dwell roll. A dwell rolled before the ceiling would let a `never`-arriving bot keep stopping
 * for ever a meter from its goal, which looks like a different fault than the one being injected.
 */
export function stepRoute(input: StepInput): StepResult {
    const noiseState = advanceNoise(input.noiseState, input.noise, input.random)
    const ceiling = travelCeiling(input.route.totalM, input.arrive)

    const speed = Math.max(0, input.speedMps * noiseState.speedFactor)
    const advance = speed * (input.dtMs / 1000)
    const travelled = Math.min(input.travelledM + advance, ceiling)
    const progressed = travelled - input.travelledM

    const position = positionAt(input.route, travelled)
    const heading = position.heading + noiseState.headingOffsetDeg
    const coords = noiseState.lateralM === 0 ? position.coords : offsetBy(position.coords, noiseState.lateralM, heading + 90)

    const arrived = input.arrive === 'normal' && travelled >= input.route.totalM - 1e-6
    const startDwell =
        !arrived && progressed > 0 && shouldDwell(progressed, input.noise.stopRatePerKm, input.random)
            ? dwellDurationMs(input.noise.stopSecs, input.random)
            : null

    return {
        travelledM: travelled,
        coords,
        heading: normaliseHeading(heading),
        speedMps: progressed > 0 ? speed : 0,
        arrived,
        startDwellMs: startDwell,
        noiseState,
    }
}

/** How far along the route this leg is allowed to get, given the arrival behaviour. */
function travelCeiling(totalM: number, arrive: 'normal' | 'never' | 'stall'): number {
    if (arrive === 'never') return Math.max(0, totalM - NEVER_ARRIVE_GAP_M)
    if (arrive === 'stall') return totalM * STALL_FRACTION
    return totalM
}

/** Wraps a bearing into 0–360, which is what the telemetry payload carries. */
export function normaliseHeading(degrees: number): number {
    const wrapped = degrees % 360
    return wrapped < 0 ? wrapped + 360 : wrapped
}
