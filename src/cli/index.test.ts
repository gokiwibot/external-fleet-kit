/**
 * The entry point, exercised as a partner runs it. `src/cli/index.ts` calls `main()` and
 * `process.exit()` at module scope, so it cannot be imported into a test — importing it would run
 * the CLI and take the test runner down with it. These tests spawn `bin/efk.mjs` instead, which also
 * puts the bin shim and the package-relative resolution under test.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { listScenarios, SCENARIO_NOTES } from '../driver/simulated'

const run = promisify(execFile)
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'efk.mjs')

/** Bounded on purpose: node's default test timeout is Infinity, and a hung CLI must fail, not wait. */
const efk = (args: string[], cwd?: string) => run(process.execPath, [BIN, ...args], { timeout: 60_000, cwd })

/** The same call, for the cases that must FAIL: asserting on a success would silently pass here. */
async function efkFails(args: string[]): Promise<{ code?: number; stderr?: string }> {
    const outcome = await efk(args).then(
        () => null,
        (error: unknown) => error as { code?: number; stderr?: string },
    )
    if (outcome === null) throw new Error(`expected \`efk ${args.join(' ')}\` to exit non-zero`)
    return outcome
}

describe('efk entry point', () => {
    it('--version names the kit, the contract and the data.ts it was frozen from', async () => {
        const { stdout } = await efk(['--version'])
        assert.match(stdout.trim(), /^efk \d+\.\d+\.\d+ · contract 2026-09 · data\.ts .+$/)
    })

    /**
     * `SCENARIO_NOTES` existed but had no consumer, so no user had
     * ever seen the one explanation that matters: `no-interrupt` parses IDENTICALLY to `default`,
     * because the knob its name promises is a fleet capability in `efk.config.ts` and not a scenario
     * field. Without the note that file is an unexplained duplicate.
     */
    it('scenarios list prints every scenario WITH its note', async () => {
        const { stdout } = await efk(['scenarios', 'list'])
        const lines = stdout.trimEnd().split('\n')
        const names = listScenarios()
        assert.equal(lines.length, names.length, 'one line per bundled scenario')
        assert.deepEqual(
            lines.map((line) => line.split(/\s{2,}/)[0]),
            names,
            'named, in alphabetical order',
        )
        for (const [index, name] of names.entries()) {
            const note = SCENARIO_NOTES[name]
            assert.ok(note, `${name} has no entry in SCENARIO_NOTES`)
            assert.ok(lines[index]?.includes(note), `the line for ${name} must carry its note, not just its name`)
        }
    })

    it('scenarios list explains why no-interrupt does nothing', async () => {
        const { stdout } = await efk(['scenarios', 'list'])
        const line = stdout.split('\n').find((l) => l.startsWith('no-interrupt'))
        assert.ok(line, 'no-interrupt is listed')
        // The three things a reader needs: that it is inert, what the knob really is, and where it lives.
        assert.match(line, /INERT/)
        assert.match(line, /supports_command_interrupt/)
        assert.match(line, /efk\.config\.ts/)
    })

    it('resolves its scenarios from the package, not from the working directory', async () => {
        // `efk` is run from a partner's own project, which has no `scenarios/` of its own.
        const [here, elsewhere] = await Promise.all([efk(['scenarios', 'list']), efk(['scenarios', 'list'], tmpdir())])
        assert.equal(elsewhere.stdout, here.stdout)
        assert.ok(here.stdout.includes('no-interrupt'))
    })

    it('answers an unknown command with the usage and exit 2, never a stack trace', async () => {
        const failed = await efkFails(['nonsense'])
        assert.equal(failed.code, 2)
        assert.match(failed.stderr ?? '', /efk — external-fleet-kit/)
        assert.doesNotMatch(failed.stderr ?? '', /at .*\.ts:\d+/, 'a usage error is not a crash')
    })

    it('answers an unknown FLAG the same way, instead of throwing out of parseArgs', async () => {
        const failed = await efkFails(['--not-a-flag'])
        assert.equal(failed.code, 2)
        assert.match(failed.stderr ?? '', /efk — external-fleet-kit/)
        assert.doesNotMatch(failed.stderr ?? '', /at .*node:internal/, 'parseArgs must not escape as an uncaught throw')
    })
})
