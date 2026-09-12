/**
 * `.efk.lock`: one `efk start` per directory. Two instances would publish conflicting `seq` for
 * the same bots (design §9.2). A lock held by a dead pid is stolen.
 *
 * The creation is `writeFileSync(path, …, { flag: 'wx' })`, which fails if the file already exists.
 * `existsSync` followed by `writeFileSync` is a check-then-act: two `efk start` launched in the same
 * second both see no file and both write, and the second silently overwrites the first — exactly the
 * two-instance case the lock exists to stop. `wx` makes the creation itself the decision point.
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
    const holder = () => {
        const release = () => {
            try {
                unlinkSync(path)
            } catch {
                // already gone
            }
        }
        return { release }
    }

    const tryCreate = (): boolean => {
        try {
            writeFileSync(path, `${JSON.stringify({ pid: deps.pid, since: deps.now() })}\n`, { flag: 'wx' })
            return true
        } catch {
            return false
        }
    }

    if (tryCreate()) return holder()

    // The file exists. Whoever wrote it either is alive (we lose) or is not (we steal it).
    let held: { pid: number; since: number } | null = null
    try {
        held = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; since: number }
    } catch {
        held = null // unreadable lock: treat as stale
    }
    if (held && deps.isAlive(held.pid)) return { held }

    try {
        unlinkSync(path)
    } catch {
        // someone else removed it first
    }
    if (tryCreate()) return holder()
    // Lost a race against a third process that grabbed it between our unlink and our create.
    try {
        const winner = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; since: number }
        return { held: winner }
    } catch {
        return { held: { pid: -1, since: deps.now() } }
    }
}
