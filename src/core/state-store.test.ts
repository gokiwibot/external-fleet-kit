import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
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

describe('state store', () => {
    it('reads defaults when the file does not exist', () => {
        const store = createStateStore(fresh())
        assert.deepEqual(store.read(), { v: 1, seq: {} })
    })
    it('writes atomically and reads back', () => {
        const path = fresh()
        const store = createStateStore(path)
        store.write({ seq: { 'ACME-0001': 42 } })
        assert.equal(existsSync(`${path}.tmp`), false, 'temp file is renamed away')
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { v: 1, seq: { 'ACME-0001': 42 } })
        assert.deepEqual(createStateStore(path).read(), { v: 1, seq: { 'ACME-0001': 42 } })
    })
    it('treats a corrupt file as empty instead of crashing, and says so', () => {
        const path = fresh()
        writeFileSync(path, '{not json')
        const discarded: string[] = []
        const store = createStateStore(path, { onDiscard: (reason) => discarded.push(reason) })
        assert.deepEqual(store.read(), { v: 1, seq: {} })
        assert.equal(discarded.length, 1, 'the reset is reported, not swallowed')
        assert.match(discarded[0] ?? '', /\.efk-state\.json/)
    })
    it('does not report a discard for the ordinary first run', () => {
        const discarded: string[] = []
        const store = createStateStore(fresh(), { onDiscard: (reason) => discarded.push(reason) })
        assert.deepEqual(store.read(), { v: 1, seq: {} })
        assert.deepEqual(discarded, [])
    })
    it('propagates an IO error instead of resetting counters it could not read', () => {
        const path = fresh()
        mkdirSync(path) // a state file that cannot be read, but whose counters are NOT gone
        const discarded: string[] = []
        const store = createStateStore(path, { onDiscard: (reason) => discarded.push(reason) })
        assert.throws(() => store.read(), /EISDIR/)
        assert.deepEqual(discarded, [], 'an unreadable file is not a discard')
    })
})
