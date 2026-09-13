import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { acquireLock } from './lock'

// Every temp directory is remembered so the run leaves nothing behind, in the repo or in /tmp.
const dirs: string[] = []
const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), 'efk-'))
    dirs.push(dir)
    return join(dir, '.efk.lock')
}
after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('lockfile', () => {
    it('acquires, refuses a second holder, releases', () => {
        const path = fresh()
        const first = acquireLock(path, { pid: 1000, now: () => 1_000, isAlive: () => true })
        assert.ok('release' in first)
        const second = acquireLock(path, { pid: 1001, now: () => 2_000, isAlive: () => true })
        assert.ok('held' in second && second.held.pid === 1000)
        first.release()
        assert.ok('release' in acquireLock(path, { pid: 1001, now: () => 3_000, isAlive: () => true }))
    })
    it('steals a lock whose pid is dead', () => {
        const path = fresh()
        acquireLock(path, { pid: 1000, now: () => 1_000, isAlive: () => true })
        const next = acquireLock(path, { pid: 1001, now: () => 2_000, isAlive: (pid) => pid !== 1000 })
        assert.ok('release' in next)
    })
    it('the creation itself is exclusive: a second acquire never overwrites the first holder', () => {
        const path = fresh()
        const first = acquireLock(path, { pid: 2000, now: () => 1_000, isAlive: () => true })
        assert.ok('release' in first)
        const second = acquireLock(path, { pid: 2001, now: () => 1_000, isAlive: () => true })
        assert.ok('held' in second)
        // The file still names the first pid: the loser wrote nothing.
        assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid, 2000)
    })
    it('release() leaves behind a lock that is no longer ours', () => {
        const path = fresh()
        const first = acquireLock(path, { pid: 3000, now: () => 1_000, isAlive: () => true })
        assert.ok('release' in first)
        // A second instance decided our pid was dead and took the lock over.
        writeFileSync(path, `${JSON.stringify({ pid: 3001, since: 2_000 })}\n`)
        first.release()
        assert.equal(existsSync(path), true, 'a foreign lock survives our release')
        assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid, 3001)
    })
    /**
     * Cross-task debt: the lost race. When the lock cannot be created AND cannot be read, there is
     * nobody to name — the old shape answered `{ held: { pid: -1, since: <now> } }`, so a CLI would
     * have printed "already running (pid -1), since just now" at a partner. A directory in the
     * lock's place is that case, deterministically: `wx` cannot create it and `readFileSync` cannot
     * read it.
     */
    it('a lock we can neither take nor read is CONTENDED, not a holder with pid -1', () => {
        const path = fresh()
        mkdirSync(path)
        const result = acquireLock(path, { pid: 4000, now: () => 9_000, isAlive: () => true })
        assert.deepEqual(result, { contended: true })
        assert.ok(!('held' in result), 'there is no holder to name, so none is invented')
    })
    it('an unreadable lock is stale and is taken over', () => {
        const path = fresh()
        writeFileSync(path, 'not json')
        assert.ok('release' in acquireLock(path, { pid: 2002, now: () => 1_000, isAlive: () => true }))
    })
})
