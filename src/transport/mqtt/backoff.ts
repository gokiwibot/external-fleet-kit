/** Exponential backoff for CONNECT: the page forbids retrying a rejected CONNECT in a tight loop. */
export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_CAP_MS = 60_000

/**
 * The clamp comes LAST, after the jitter. Clamping first and then jittering would let the wait reach
 * 72 s — 20 % over the ceiling the contract states — so the number the page promises would not be the
 * number the kit honours. Jittering first keeps the ±20 % spread everywhere below the cap (which is
 * what the jitter is for: not synchronising a whole fleet's reconnects) and makes 60 s a real ceiling.
 */
export function nextBackoffMs(attempt: number, random: () => number = Math.random): number {
    const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
    const jitter = 1 + (random() * 2 - 1) * 0.2
    return Math.min(BACKOFF_CAP_MS, Math.round(raw * jitter))
}
