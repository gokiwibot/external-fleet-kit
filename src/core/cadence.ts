/**
 * When to publish a BotState (design §9.1), from the "Cadence" note of POST /state — the stricter
 * of the two delivery forms, so the same runtime serves MQTT and HTTP push:
 *  - moving: at least every second;
 *  - any change to available / connected / door / current_command: within 1 s (we publish on the tick);
 *  - idle: at least every 15 s, so freshness can be told from silence.
 * The tick is 250 ms; this module only answers "is it time" for a given tick.
 *
 * The "within 1 s" rule needs no deadline literal here: `changed` publishes immediately, and the
 * driving tick is 250 ms, so the actual gap is always well under the 1 s the contract allows.
 */
export const TICK_MS = 250
export const MOVING_INTERVAL_MS = 1_000
export const IDLE_HEARTBEAT_MS = 15_000

export type CadenceInput = { nowMs: number; lastPublishedAtMs: number | null; moving: boolean; changed: boolean }

export interface Cadence {
    shouldPublish(input: CadenceInput): boolean
}

export function createCadence(config = { movingIntervalMs: MOVING_INTERVAL_MS, idleHeartbeatMs: IDLE_HEARTBEAT_MS }): Cadence {
    return {
        shouldPublish({ nowMs, lastPublishedAtMs, moving, changed }) {
            if (lastPublishedAtMs === null || changed) return true
            const elapsed = nowMs - lastPublishedAtMs
            if (moving) return elapsed >= config.movingIntervalMs
            return elapsed >= config.idleHeartbeatMs
        },
    }
}
