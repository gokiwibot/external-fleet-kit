#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { loadConfig } from '../config'
import { CONTRACT_VERSION } from '../contract/version'
import { createFakeRemiClient } from '../core/fake-remi'
import { listScenarios, SCENARIO_NOTES } from '../driver/simulated'
import { describeThrown, stackFramesWithoutMessage } from '../net-failure'
import { createRemiClient } from '../remi/client'
import { formatReport, runCheck } from './check'
import { loadEnv } from './env'
import { createOrder, watchOrder } from './order'
import { httpProbe, mqttProbe, parityProbe } from './probes'
import { start } from './start'

const OPTIONS = {
    version: { type: 'boolean' },
    json: { type: 'boolean' },
    scenario: { type: 'string' },
    web: { type: 'boolean' },
    'web-host': { type: 'string', default: '127.0.0.1' },
    headless: { type: 'boolean' },
    check: { type: 'boolean' },
    demo: { type: 'boolean' },
    name: { type: 'string', default: 'efk test order' },
    watch: { type: 'boolean' },
} as const

const usage = `efk — external-fleet-kit
  efk check [--json]
  efk start [--scenario <name>] [--web] [--web-host <host>] [--headless] [--check] [--demo]
  efk order create [--name <n>] [--watch]
  efk order watch <delivery id>
  efk scenarios list
  efk --version

--demo (or EFK_FAKE_REMI=1) runs against a fake roster and never talks to remi. For looking at the
TUI and the dashboard without credentials; nothing you see in that mode is real.`

async function main(): Promise<number> {
    // Inside `main`, not at module scope: `parseArgs` THROWS on an unknown flag, and at module scope
    // that throw escapes before the catch below exists — a partner who mistypes `--headles` gets a
    // stack trace instead of the usage, from a process that never reached its own entry point.
    let values: Partial<Record<keyof typeof OPTIONS, string | boolean>>
    let positionals: string[]
    try {
        const parsed = parseArgs({ allowPositionals: true, options: { ...OPTIONS } })
        values = parsed.values
        positionals = parsed.positionals
    } catch (error) {
        console.error(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`)
        return 2
    }

    if (values.version) {
        const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
        const source = JSON.parse(readFileSync(new URL('../contract/samples/SOURCE.json', import.meta.url), 'utf8')) as { commit: string }
        console.info(`efk ${pkg.version} · contract ${CONTRACT_VERSION} · data.ts ${source.commit}`)
        return 0
    }
    const [command, sub, arg] = positionals
    switch (command) {
        case 'check': {
            const env = loadEnv()
            const config = await loadConfig()
            const demo = (values.demo ?? false) || process.env.EFK_FAKE_REMI === '1'
            const remi = demo
                ? createFakeRemiClient()
                : createRemiClient({
                      baseUrl: env.ok ? env.env.REMI_API_URL : 'https://remi.kiwi',
                      apiKey: env.ok ? env.env.REMI_API_KEY : '',
                  })
            const report = await runCheck({
                env: env.ok ? env.env : null,
                envError: env.ok ? undefined : env.error,
                remi,
                config: config.ok ? config.config : null,
                configError: config.ok ? undefined : config.error,
                mqttProbe,
                httpProbe,
                parity: parityProbe,
                demo: demo === true,
                now: Date.now,
                random: Math.random,
            })
            console.info(values.json ? JSON.stringify(report, null, 2) : formatReport(report))
            return report.exitCode
        }
        case 'start':
            return start({
                scenario: typeof values.scenario === 'string' ? values.scenario : undefined,
                web: values.web === true,
                webHost: typeof values['web-host'] === 'string' ? values['web-host'] : '127.0.0.1',
                headless: values.headless === true,
                check: values.check === true,
                demo: values.demo === true,
            })
        case 'order': {
            const env = loadEnv()
            if (!env.ok) {
                console.error(env.error)
                return 1
            }
            const remi = createRemiClient({ baseUrl: env.env.REMI_API_URL, apiKey: env.env.REMI_API_KEY })
            if (sub === 'create') {
                const created = await createOrder(remi, env.env, typeof values.name === 'string' ? values.name : 'efk test order', Date.now)
                if (!created.ok) {
                    console.error(`POST /api/v3/delivery/ → ${created.status} ${created.code}: ${created.message}`)
                    return 1
                }
                console.info(`created ${created.data.id} (${created.data.state})`)
                if (!values.watch) return 0
                return (await watchOrder(remi, created.data.id, {
                    intervalMs: 2_000,
                    timeoutMs: 30 * 60_000,
                    onState: (d) =>
                        console.info(
                            `${new Date().toISOString()} ${d.id} ${d.state}${d.bot ? ` bot=${d.bot.id}` : ''}${d.arriving ? ' arriving' : ''}`,
                        ),
                })) === 'delivered'
                    ? 0
                    : 1
            }
            if (sub === 'watch' && arg) {
                return (await watchOrder(remi, arg, {
                    intervalMs: 2_000,
                    timeoutMs: 30 * 60_000,
                    onState: (d) => console.info(`${new Date().toISOString()} ${d.id} ${d.state}${d.bot ? ` bot=${d.bot.id}` : ''}`),
                })) === 'delivered'
                    ? 0
                    : 1
            }
            console.error(usage)
            return 2
        }
        case 'scenarios': {
            /**
             * From the package, not from process.cwd(): `efk` is run from a partner's own project.
             *
             * THE NOTE IS NOT DECORATION (controller ruling R18). `no-interrupt` parses IDENTICALLY
             * to `default` — the knob its name promises, `supports_command_interrupt`, is a fleet
             * capability set in `efk.config.ts`, so there is nothing for the JSON to say. Until
             * something printed `SCENARIO_NOTES` no user had ever seen that explanation, and the
             * file read as an unexplained duplicate. Anything that prints a scenario name prints its
             * note with it.
             */
            const names = listScenarios()
            const width = Math.max(0, ...names.map((name) => name.length))
            for (const name of names) {
                const note = SCENARIO_NOTES[name]
                console.info(`${name.padEnd(width)}  ${note ?? 'no note yet — add one to SCENARIO_NOTES in src/driver/simulated/index.ts'}`)
            }
            return 0
        }
        default:
            console.error(usage)
            return 2
    }
}

main().then(
    (code) => process.exit(code),
    (error: unknown) => {
        /**
         * The last resort. It used to `console.error(error)`, printing the raw object and its stack —
         * the same shape the `parseArgs` handler above was fixed for, and the same credential problem
         * every other path was fixed for, since `Error.stack` BEGINS with the message.
         *
         * So the sentence is constructed, and the frames are printed with the message removed by
         * `stackFramesWithoutMessage` — EXACTLY, by length, never by matching what a frame looks
         * like. See that function for the counter-example that killed the pattern-matching version.
         */
        console.error(
            `efk hit an error it does not handle: ${describeThrown(error)}. This is a bug in the kit — send Robot.com the lines below.`,
        )
        const frames = stackFramesWithoutMessage(error)
        if (frames) console.error(frames)
        process.exit(1)
    },
)
