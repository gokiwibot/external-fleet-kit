/**
 * Freezes the JSON samples of /docs/external-fleets into src/contract/samples/.
 *
 * For US, with kiwi-platforms next to this repo: `pnpm sync-samples -- <path to data.ts> [<commit>]`.
 * Walks data.ts tracking the nearest preceding `id: '…'` and `label: '…'`, and writes every
 * `code: \`…\`` block that parses as JSON to `samples/<id>__<label-slug>.json`. Blocks with a
 * `/* Type *\/` shorthand are not JSON and are skipped. Identical (name, content) duplicates collapse
 * into one file; a same-name different-content block gets a `-2` suffix so nothing is overwritten.
 *
 * Writes SOURCE.json with { commit, sha256, extractedAt, files, skipped }. `sha256` is ALWAYS the
 * digest of the data.ts the samples came from, and `commit` is the commit it was read at; the two
 * names match `KIT_SYNC.json` next to the contract page on the remi side, which records the same
 * digest as `data_ts_sha256`. There is no `baseSha256`: one digest, one name, or the drift job on the
 * remi side compares against a field that does not exist.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// pnpm 9+ forwards the `--` separator to the script instead of swallowing it, so the documented
// `pnpm sync-samples -- <path>` would otherwise arrive as the argument `--`. Drop it.
const [dataTsPath, commit = 'unknown'] = process.argv.slice(2).filter((arg) => arg !== '--')
if (!dataTsPath) {
    console.error('usage: pnpm sync-samples -- <path to data.ts> [<commit>]')
    process.exit(2)
}

const source = readFileSync(dataTsPath, 'utf8')
const outDir = join(import.meta.dirname, '..', 'src', 'contract', 'samples')
mkdirSync(outDir, { recursive: true })
for (const file of readdirSync(outDir)) {
    if (file.endsWith('.json') && file !== 'SOURCE.json' && !file.startsWith('handmade__')) rmSync(join(outDir, file))
}

const slug = (label: string) =>
    label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')

const pattern = /id: '([a-z0-9-]+)'|label: '([^']+)'|code: `([\s\S]*?)`/g
let id = 'unknown'
let label = 'unknown'
const written = new Map<string, string>()
const skipped: string[] = []
for (const match of source.matchAll(pattern)) {
    if (match[1]) id = match[1]
    else if (match[2]) label = match[2]
    else if (match[3] !== undefined) {
        let parsed: unknown
        try {
            parsed = JSON.parse(match[3])
        } catch {
            skipped.push(`${id}__${slug(label)}`)
            continue
        }
        const content = `${JSON.stringify(parsed, null, 2)}\n`
        let name = `${id}__${slug(label)}`
        if (written.has(name) && written.get(name) !== content) name = `${name}-2`
        written.set(name, content)
    }
}
for (const [name, content] of written) writeFileSync(join(outDir, `${name}.json`), content)

const sha256 = createHash('sha256').update(source).digest('hex')
writeFileSync(
    join(outDir, 'SOURCE.json'),
    `${JSON.stringify({ commit, sha256, extractedAt: new Date().toISOString(), files: [...written.keys()].sort(), skipped }, null, 2)}\n`,
)
console.info(`wrote ${written.size} samples (${skipped.length} skipped) from ${dataTsPath} @ ${commit}`)
