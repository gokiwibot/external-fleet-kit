import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    it('treats a corrupt file as empty instead of crashing', () => {
        const path = fresh()
        writeFileSync(path, '{not json')
        assert.deepEqual(createStateStore(path).read(), { v: 1, seq: {} })
    })
})
