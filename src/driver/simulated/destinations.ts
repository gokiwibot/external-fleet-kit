/**
 * Destination correction, with fixed values (grid 0.0002°, threshold
 * 300 m) but measured from the FLEET ORIGIN, never from the bot: the contract requires
 * POST /destinations/validate to be idempotent ("the same coordinate must return the same answer"),
 * and anything measured from the bot changes every second.
 *
 * ORDER MATTERS: snap FIRST, then check the service area. The snapped point is where the robot would
 * actually stop, so it is the point whose reachability decides the answer. Checking the raw target
 * first makes a destination 1 cm outside the area unreachable even though its grid node is inside —
 * and, worse, makes `resolve` and the eventual drive disagree about where the bot is going.
 *
 * `distanceM` has ONE definition in both branches: the distance from the REQUESTED destination to the
 * nearest navigable point. Reachable → that point is the grid node, so it is the size of the snap.
 * Unreachable → that point is the closest one inside the service area, on the line origin→CORRECTED
 * point at `unreachableBeyondM` from the origin, so it is how far past the edge the request fell.
 *
 * BASIS, deliberately: the overshoot is measured from the CORRECTED (snapped) point, not the raw
 * target. The reachability check already measures `origin → corrected` (order matters: snap first),
 * so reporting the overshoot from anything else — in particular from the raw target — can disagree
 * with that check and go negative: snapping can push a point that was inside the raw threshold to
 * outside the corrected one (or the reverse), and the contract types this field `z.number().min(0)`.
 * The corrected point is also the one the robot actually drives to, so it is the honest number to
 * report to the partner, not just the one that happens to stay non-negative.
 */
import type { DestinationValidation } from '../../contract/schemas'
import type { Position } from '../robot-driver'
import { metersBetween } from './motion'
import type { BotScenario } from './scenario'

export type Resolution = { kind: 'ok'; corrected: Position; distanceM: number } | { kind: 'unreachable'; distanceM: number }

export interface Destinations {
    resolve(target: Position): Resolution
    validate(target: Position): DestinationValidation
}

const round1 = (value: number) => Math.round(value * 10) / 10

export function createDestinations(spec: BotScenario['destinations'], origin: Position): Destinations {
    const snapValue = (value: number) => (spec.snapGridDeg > 0 ? Math.round(value / spec.snapGridDeg) * spec.snapGridDeg : value)
    const round7 = (value: number) => Number(value.toFixed(7))

    const resolve = (target: Position): Resolution => {
        const corrected = spec.snapGridDeg > 0 ? { lat: round7(snapValue(target.lat)), lng: round7(snapValue(target.lng)) } : target
        if (spec.unreachableBeyondM > 0) {
            const fromOrigin = metersBetween(origin, corrected)
            if (fromOrigin > spec.unreachableBeyondM) {
                // Same basis as the check above (`fromOrigin`, measured to the CORRECTED point): the
                // nearest navigable point sits on the edge of the service disc along that bearing, so
                // reusing `fromOrigin` here is what keeps the overshoot from ever going negative.
                return { kind: 'unreachable', distanceM: round1(fromOrigin - spec.unreachableBeyondM) }
            }
        }
        return { kind: 'ok', corrected, distanceM: spec.snapGridDeg > 0 ? round1(metersBetween(target, corrected)) : 0 }
    }

    return {
        resolve,
        validate(target) {
            const r = resolve(target)
            if (r.kind === 'unreachable') return { reachable: false, reason: 'out_of_service_area', correction_distance_m: r.distanceM }
            return { reachable: true, corrected_position: r.corrected, correction_distance_m: r.distanceM }
        },
    }
}
