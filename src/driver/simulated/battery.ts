/** New in the kit (bot-sim models battery as a payload overlay). Drain per km, optional recharge at rest. */
import type { BotScenario } from './scenario'

export interface Battery {
    /**
     * Call once per tick: metres travelled in the tick, elapsed ms, and whether a navigation is live.
     * Recharge needs BOTH no metres AND no navigation: a bot dwelling mid-route — a traffic light, an
     * unplanned stop from the noise model — travels zero metres for a few ticks, and without the
     * second condition it would charge itself in the middle of the street and the low-battery
     * scenarios would never reproduce anything.
     */
    advance(metersTravelled: number, elapsedMs: number, navigating: boolean): void
    percentage(): number
    unavailable(): boolean
}

export function createBattery(spec: BotScenario['battery']): Battery {
    let level = spec.startPct
    return {
        advance(metersTravelled, elapsedMs, navigating) {
            level -= (metersTravelled / 1000) * spec.drainPctPerKm
            if (metersTravelled === 0 && !navigating && spec.rechargePctPerMin > 0) level += (elapsedMs / 60_000) * spec.rechargePctPerMin
            level = Math.min(100, Math.max(0, level))
        },
        percentage: () => Math.round(level),
        unavailable: () => spec.unavailableBelowPct > 0 && Math.round(level) < spec.unavailableBelowPct,
    }
}
