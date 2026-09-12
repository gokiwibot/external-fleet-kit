/**
 * `.efk.lock`: one `efk start` per directory. Two instances would publish conflicting `seq` for
 * the same bots (design §9.2). A lock held by a dead pid is stolen.
 *
 * The creation is `writeFileSync(path, …, { flag: 'wx' })`, which fails if the file already exists.
 * `existsSync` followed by `writeFileSync` is a check-then-act: two `efk start` launched in the same
 * second both see no file and both write, and the second silently overwrites the first — exactly the
 * two-instance case the lock exists to stop. `wx` makes the creation itself the decision point.
 *
 * Releasing is the mirror image: a holder removes ONLY the lock it wrote. If our lock was broken and
 * taken over (our pid looked dead to the newcomer), the file on disk is now someone else's, and
 * unlinking it would let a third instance in alongside the second — the two-writer case again.
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export type LockDeps = { pid: number; now: () => number; isAlive: (pid: number) => boolean }
export type LockResult = { release(): void } | { held: { pid: number; since: number } }

export function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

export function acquireLock(path: string, deps: LockDeps): LockResult {
    /** The current holder, or null when the file is missing, unreadable or not a lock we understand. */
    const readHolder = (): { pid: number; since: number } | null => {
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; since?: unknown }
            if (typeof parsed?.pid !== 'number' || typeof parsed?.since !== 'number') return null
            return { pid: parsed.pid, since: parsed.since }
        } catch {
            return null // unreadable lock: treat as stale
        }
    }

    /** Creates the lock or returns null if someone else already holds it. `wx` is the decision point. */
    const create = (): { release(): void } | null => {
        const since = deps.now()
        try {
            writeFileSync(path, `${JSON.stringify({ pid: deps.pid, since })}\n`, { flag: 'wx' })
        } catch {
            return null
        }
        return {
            release() {
                const current = readHolder()
                // Not ours any more: leave it. Removing a foreign lock is how a third writer gets in.
                if (current === null || current.pid !== deps.pid || current.since !== since) return
                try {
                    unlinkSync(path)
                } catch {
                    // already gone
                }
            },
        }
    }

    const mine = create()
    if (mine) return mine

    // The file exists. Whoever wrote it either is alive (we lose) or is not (we steal it).
    const held = readHolder()
    if (held && deps.isAlive(held.pid)) return { held }

    try {
        unlinkSync(path)
    } catch {
        // someone else removed it first
    }
    const stolen = create()
    if (stolen) return stolen
    // Lost a race against a third process that grabbed it between our unlink and our create.
    return { held: readHolder() ?? { pid: -1, since: deps.now() } }
}
