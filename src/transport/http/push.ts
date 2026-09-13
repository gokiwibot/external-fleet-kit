/**
 * Optional push (HTTP_PUSH=true): `POST /api/v3/fleet/state` with ≤ 200 states per request, once per
 * tick, and `POST /api/v3/fleet/events` per event. 5xx retried with bounded backoff; 4xx logged and
 * dropped.
 *
 * ONE FLIGHT PER ENDPOINT. Retries used to be able to overlap: a 250 ms tick fires again long before
 * five retries with a 1→16 s backoff have finished, so a remi that is down for a minute accumulated
 * dozens of concurrent retry chains, all of them carrying stale states nobody wants any more. Here a
 * push that is still in flight makes the next tick SKIP — the state it would have sent is superseded
 * by the next one anyway, which is the whole point of a state and not an event stream.
 */
import type { BotEvent, BotState } from '../../contract/schemas'
import type { EventBus } from '../../core/events'
import type { RemiClient } from '../../remi/client'
import { nextBackoffMs } from '../mqtt/backoff'

export const MAX_STATES_PER_REQUEST = 200

/** Remedies for the failures a partner can actually do something about. */
function remedyFor(status: number, code: string): string {
    if (status === 413 || code === 'PAYLOAD_TOO_LARGE') {
        return ' — the batch is too large for remi; it is already split at 200 states, so this means your states carry something oversized (check for a huge `detail` or an unexpected field)'
    }
    if (status === 401 || status === 403) return ' — REMI_API_KEY is not valid, or lacks the `fleet` scope'
    if (status === 404) return ' — remi does not know this fleet or this bot; run `efk check`'
    if (status === 422) return ' — remi refused the state itself; the message names the field'
    return ''
}

export function createPushClient(deps: { remi: RemiClient; bus: EventBus; sleep?: (ms: number) => Promise<void>; random?: () => number }) {
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    let stateInFlight = false
    let skipped = 0

    const retrying = async <T>(
        label: string,
        attempt: () => Promise<{ ok: true; data: T } | { ok: false; status: number; code: string; message: string }>,
    ) => {
        for (let n = 0; n < 5; n += 1) {
            const result = await attempt()
            if (result.ok) return result
            if (result.status > 0 && result.status < 500) {
                deps.bus.emit('log', {
                    level: 'warn',
                    message: `${label} rejected by remi: ${result.status} ${result.code} ${result.message}${remedyFor(result.status, result.code)}`,
                })
                return result
            }
            await sleep(nextBackoffMs(n, deps.random))
        }
        deps.bus.emit('log', { level: 'error', message: `${label} gave up after 5 attempts` })
        return { ok: false as const, status: 0, code: 'GAVE_UP', message: label }
    }

    return {
        /**
         * Sends the whole batch of this tick. Skips entirely while a previous push is still going.
         * Answers whether every chunk REALLY reached remi — a skip and a give-up are both `false`,
         * because in both the states stayed here. The transport reads it to tell a recovery from a
         * run of healthy ticks (see `flushTick`).
         */
        async pushState(states: BotState[]): Promise<boolean> {
            if (states.length === 0) return true
            if (stateInFlight) {
                skipped += 1
                if (skipped % 40 === 1) {
                    deps.bus.emit('log', {
                        level: 'warn',
                        message: `a POST /api/v3/fleet/state is still in flight; skipped ${skipped} batch(es) — states supersede each other, so nothing is lost, but remi is slow or unreachable`,
                    })
                }
                return false
            }
            stateInFlight = true
            let delivered = true
            try {
                for (let i = 0; i < states.length; i += MAX_STATES_PER_REQUEST) {
                    const result = await retrying('POST /api/v3/fleet/state', () =>
                        deps.remi.pushState(states.slice(i, i + MAX_STATES_PER_REQUEST)),
                    )
                    if (!result.ok) delivered = false
                }
                skipped = 0
            } finally {
                stateInFlight = false
            }
            return delivered
        },
        async pushEvent(event: BotEvent): Promise<void> {
            // Events are NOT superseded by the next one, so they are never skipped.
            await retrying('POST /api/v3/fleet/events', () => deps.remi.reportEvent(event))
        },
    }
}
