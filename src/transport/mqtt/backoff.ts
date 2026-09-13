/** Exponential backoff for CONNECT: the page forbids retrying a rejected CONNECT in a tight loop. */
export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_CAP_MS = 60_000

export function nextBackoffMs(attempt: number, random: () => number = Math.random): number {
    const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
    const jitter = 1 + (random() * 2 - 1) * 0.2
    return Math.round(raw * jitter)
}
