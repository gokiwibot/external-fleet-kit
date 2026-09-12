import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createSeq } from './seq'
import { createStateStore } from './state-store'

// Every temp directory is remembered so the run leaves nothing behind, in the repo or in /tmp.
const dirs: string[] = []
const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), 'efk-'))
    dirs.push(dir)
    return join(dir, '.efk-state.json')
}
after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('seq', () => {
    it('starts at 1 for a new bot and increments per publish', () => {
        const store = createStateStore(fresh())
        const seq = createSeq(store)
        assert.equal(seq.next('ACME-0001'), 1)
        assert.equal(seq.next('ACME-0001'), 2)
        assert.equal(seq.next('ACME-0002'), 1)
        assert.equal(seq.peek('ACME-0001'), 2)
        seq.flush()
    })
    it('continues from the persisted value after a restart, flushing on stop', () => {
        const path = fresh()
        const first = createSeq(createStateStore(path))
        first.next('ACME-0001')
        first.next('ACME-0001')
        first.flush()
        const second = createSeq(createStateStore(path))
        assert.equal(second.next('ACME-0001'), 3)
        second.flush()
    })
    it('debounces the write: many publishes, one file write', () => {
        const path = fresh()
        let writes = 0
        const store = createStateStore(path)
        const counting = {
            read: store.read,
            write: (patch: Parameters<typeof store.write>[0]) => {
                writes += 1
                store.write(patch)
            },
        }
        // `!` (no initializer) keeps the declared type: TS narrows an initialized `let` to `null` and
        // does not track the assignment made inside `setTimer`, which would make `fire?.()` uncallable.
        let fire!: (() => void) | null
        const seq = createSeq(counting, {
            debounceMs: 1_000,
            setTimer: (fn) => {
                fire = fn
                return 1 as never
            },
            clearTimer: () => {},
        })
        for (let i = 0; i < 500; i += 1) seq.next('ACME-0001')
        assert.equal(writes, 0, 'nothing written until the debounce fires')
        fire?.()
        assert.equal(writes, 1)
        assert.equal(createSeq(createStateStore(path)).peek('ACME-0001'), 500)
    })
})
