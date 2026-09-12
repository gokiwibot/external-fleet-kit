import type { StateStore } from './state-store'

export interface Seq {
    /** The next seq to publish for this bot. Persisted on a 1 s debounce, and on flush(). */
    next(botId: string): number
    peek(botId: string): number
    /** Writes the pending counters now. Called by `stop()` and by the tests. */
    flush(): void
}

export type SeqDeps = {
    debounceMs?: number
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/**
 * Per-bot monotonic `seq`, continuing from the persisted value. A brand-new bot starts at 1.
 *
 * The counter lives in memory and reaches disk on a 1 s debounce, never once per publish: 200 bots
 * at 4 Hz would be 800 synchronous writes a second onto the same file, which is both a stall and a
 * much wider window for a torn file. What the debounce risks is losing up to a second of counters on
 * a kill -9 — and that costs a handful of states rejected by remi's `seq` guard after a restart,
 * which is exactly the trade the design accepts (§9.2). `stop()` flushes, so an orderly exit loses
 * nothing. The timer is injected so the test does not sleep.
 */
export function createSeq(store: StateStore, deps: SeqDeps = {}): Seq {
    const debounceMs = deps.debounceMs ?? 1_000
    const setTimer = deps.setTimer ?? setTimeout
    const clearTimer = deps.clearTimer ?? clearTimeout
    const current = new Map<string, number>(Object.entries(store.read().seq))
    let pending: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
        if (pending !== null) {
            clearTimer(pending)
            pending = null
        }
        store.write({ seq: Object.fromEntries(current) })
    }

    return {
        next(botId) {
            const value = (current.get(botId) ?? 0) + 1
            current.set(botId, value)
            if (pending === null) pending = setTimer(flush, debounceMs)
            return value
        },
        peek(botId) {
            return current.get(botId) ?? 0
        },
        flush,
    }
}
