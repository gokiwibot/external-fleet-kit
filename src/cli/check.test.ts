import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FakeDriver } from '../core/fakes'
import type { RemiClient } from '../remi/client'
import { formatReport, runCheck } from './check'
import { loadEnv } from './env'

const envSource = {
    REMI_API_URL: 'https://remi.kiwi',
    REMI_API_KEY: `live_sk_${'0'.repeat(48)}`,
    REMI_TRANSPORT: 'mqtt',
    MQTT_HOST: 'h',
    MQTT_USERNAME: 'fleet_acme',
    MQTT_PASSWORD: 'p',
    SANDBOX_LOCATION_ID: 'L1',
    SANDBOX_CENTER_LAT: '0',
    SANDBOX_CENTER_LNG: '0',
}
const config = {
    namespace: 'acme',
    bot_id_prefix: 'ACME-',
    transport: 'mqtt' as const,
    base_url: null,
    token_set: false,
    poll_interval_active_ms: 2000,
    poll_interval_idle_ms: 15000,
    max_bots: 40,
    contract_version: '2026-09',
}
const mirror = (id: string, extra: Partial<{ location_id: string | null; blocked_by: string[]; assignable: boolean }> = {}) => ({
    bot_id: id,
    location_id: 'L1',
    assignable: true,
    blocked_by: [] as never[],
    state_age_ms: 500,
    current_job_id: null,
    ...extra,
})

function remi(overrides: Partial<RemiClient> = {}): RemiClient {
    return {
        getFleetConfig: async () => ({ ok: true, data: config }),
        listFleetBots: async () => ({ ok: true, data: [mirror('ACME-0001')] }),
        listDeliveries: async () => ({ ok: true, data: null }),
        createDelivery: async () => ({ ok: false, status: 0, code: '', message: '' }),
        getDelivery: async () => ({ ok: false, status: 0, code: '', message: '' }),
        pushState: async () => ({ ok: true, data: { accepted: 0, rejected: 0 } }),
        reportEvent: async () => ({ ok: true, data: { accepted: true } }),
        ...overrides,
    } as RemiClient
}

function deps(over: Partial<Parameters<typeof runCheck>[0]> = {}) {
    const env = loadEnv(envSource)
    return {
        env: env.ok ? env.env : null,
        envError: env.ok ? undefined : env.error,
        remi: remi(),
        config: { driver: (botId: string) => new FakeDriver(botId), fleet: { supportsCommandInterrupt: true } },
        mqttProbe: async () => ({ connack: true, grantedQos: 1 }),
        httpProbe: async () => ({ status: 200, body: { bots: [] } }),
        parity: async () => ({ ok: true, detail: '31 samples' }),
        demo: false,
        now: () => 0,
        random: () => 0.5,
        ...over,
    }
}
const rule = (report: Awaited<ReturnType<typeof runCheck>>, id: string) => report.rules.find((r) => r.id === id)

describe('efk check', () => {
    it('all green on a healthy mqtt setup', async () => {
        const report = await runCheck(deps())
        assert.equal(report.exitCode, 0)
        assert.deepEqual(
            report.rules.filter((r) => r.status === 'FAIL'),
            [],
        )
        assert.equal(rule(report, 'C6')?.status, 'SKIP', 'http rule skipped in mqtt mode')
    })
    it('C1 FAIL on an unparseable .env names the variable and stops the dependent rules', async () => {
        const report = await runCheck(deps({ env: null, envError: 'MQTT_HOST: required when REMI_TRANSPORT=mqtt' }))
        assert.equal(rule(report, 'C1')?.status, 'FAIL')
        assert.match(rule(report, 'C1')?.message ?? '', /MQTT_HOST/)
        assert.equal(report.exitCode, 1)
    })
    it('C1 FAIL for an EMPTY MQTT_PASSWORD says where the value comes from, and C5 is skipped', async () => {
        const env = loadEnv({ ...envSource, MQTT_PASSWORD: '' })
        assert.equal(env.ok, true, 'the .env parses: an empty password is how the file is delivered')
        const report = await runCheck(deps({ env: env.ok ? env.env : null }))
        assert.equal(rule(report, 'C1')?.status, 'FAIL')
        assert.match(rule(report, 'C1')?.message ?? '', /MQTT runbook, step 4/)
        assert.equal(rule(report, 'C5')?.status, 'SKIP', 'connecting with no password would blame the credential')
        assert.equal(report.exitCode, 1)
    })
    it('C2: 401 / 403 / 404 map to the three remedies; version and max_bots are WARNs', async () => {
        for (const [status, code, pattern] of [
            [401, 'UNAUTHORIZED', /not valid/i],
            [403, 'FORBIDDEN', /scope `fleet`/],
            [404, 'FLEET_NOT_CONFIGURED', /not configured your fleet/i],
        ] as const) {
            const report = await runCheck(deps({ remi: remi({ getFleetConfig: async () => ({ ok: false, status, code, message: '' }) }) }))
            assert.equal(rule(report, 'C2')?.status, 'FAIL')
            assert.match(rule(report, 'C2')?.message ?? '', pattern)
        }
        const warn = await runCheck(
            deps({ remi: remi({ getFleetConfig: async () => ({ ok: true, data: { ...config, contract_version: '2027-01' } }) }) }),
        )
        assert.equal(rule(warn, 'C2')?.status, 'WARN')
        const many = await runCheck(
            deps({ remi: remi({ getFleetConfig: async () => ({ ok: true, data: { ...config, max_bots: 500 } }) }) }),
        )
        assert.equal(rule(many, 'C2')?.status, 'WARN', 'above 200 is a warning, not a schema error that stops the fleet')
    })
    it('C2 names REMI_API_URL when remi is simply not reachable, instead of printing `0 NETWORK`', async () => {
        // What the client returns for a DNS failure or a typo in the URL — the commonest C2 failure.
        const report = await runCheck(
            deps({ remi: remi({ getFleetConfig: async () => ({ ok: false, status: 0, code: 'NETWORK', message: 'fetch failed' }) }) }),
        )
        assert.equal(rule(report, 'C2')?.status, 'FAIL')
        assert.match(rule(report, 'C2')?.message ?? '', /REMI_API_URL/)
        assert.match(rule(report, 'C2')?.message ?? '', /fetch failed/)
    })
    it('C2 FAILs when MQTT_USERNAME implies a different namespace than remi reports', async () => {
        // No extra variable in the .env: the credential already encodes it as `fleet_<ns>`.
        const report = await runCheck(
            deps({ remi: remi({ getFleetConfig: async () => ({ ok: true, data: { ...config, namespace: 'other_partner' } }) }) }),
        )
        assert.equal(rule(report, 'C2')?.status, 'FAIL')
        // The brief's own regex read `namespace \`other_partner\``; the message it checks says
        // "your namespace is `other_partner`". One `is` apart, and the assertion's claim — both
        // namespaces named, in order — is unchanged.
        assert.match(rule(report, 'C2')?.message ?? '', /namespace `acme`.*namespace is `other_partner`/s)
    })
    it('C2 FAILs in demo mode: none of these answers came from remi', async () => {
        const report = await runCheck(deps({ demo: true }))
        assert.equal(rule(report, 'C2')?.status, 'FAIL')
        assert.match(rule(report, 'C2')?.message ?? '', /EFK_FAKE_REMI/)
        assert.equal(rule(report, 'C3')?.status, 'SKIP')
    })
    it('C3 reports EVERY condition that trips, not just the first', async () => {
        assert.equal(
            rule(await runCheck(deps({ remi: remi({ listFleetBots: async () => ({ ok: true, data: [] }) }) })), 'C3')?.status,
            'FAIL',
        )
        const other = await runCheck(
            deps({ remi: remi({ listFleetBots: async () => ({ ok: true, data: [mirror('ACME-0001', { location_id: 'L2' })] }) }) }),
        )
        assert.equal(rule(other, 'C3')?.status, 'WARN')
        assert.match(rule(other, 'C3')?.message ?? '', /another location/)
        const bad = await runCheck(deps({ remi: remi({ listFleetBots: async () => ({ ok: true, data: [mirror('acme/1')] }) }) }))
        assert.equal(rule(bad, 'C3')?.status, 'FAIL')
        // Unplaced AND elsewhere AND retired at once: a freshly provisioned fleet often has several.
        const several = await runCheck(
            deps({
                remi: remi({
                    listFleetBots: async () => ({
                        ok: true,
                        data: [
                            mirror('ACME-0001', { location_id: null }),
                            mirror('ACME-0002', { location_id: 'L2' }),
                            mirror('ACME-0003', { blocked_by: ['retired'] }),
                        ],
                    }),
                }),
            }),
        )
        const message = rule(several, 'C3')?.message ?? ''
        assert.match(message, /has not placed ACME-0001/)
        assert.match(message, /ACME-0002 sit in another location/)
        assert.match(message, /retired: ACME-0003/)
    })
    it('C4 explains blocked_by and never fails', async () => {
        const report = await runCheck(
            deps({
                remi: remi({
                    listFleetBots: async () => ({
                        ok: true,
                        data: [mirror('ACME-0001', { assignable: false, blocked_by: ['disconnected', 'no_position'] })],
                    }),
                }),
            }),
        )
        assert.equal(rule(report, 'C4')?.status, 'WARN')
        assert.match(rule(report, 'C4')?.message ?? '', /efk start/)
    })
    it('C5: not authorised → FAIL with the credential remedy and the rate-limit warning; QoS 0 → WARN', async () => {
        const fail = await runCheck(
            deps({ mqttProbe: async () => ({ connack: false, grantedQos: -1, error: 'Connection refused: Not authorized' }) }),
        )
        assert.equal(rule(fail, 'C5')?.status, 'FAIL')
        assert.match(rule(fail, 'C5')?.message ?? '', /MQTT_USERNAME/)
        assert.match(
            rule(fail, 'C5')?.message ?? '',
            /banned for a few minutes/,
            'retrying by hand in a loop is what a partner does next, and it makes things worse',
        )
        const qos0 = await runCheck(deps({ mqttProbe: async () => ({ connack: true, grantedQos: 0 }) }))
        assert.equal(rule(qos0, 'C5')?.status, 'WARN')
    })
    it('C6 in http mode: reachable with all bots → still WARN with the literal caveat; connection refused → FAIL', async () => {
        const httpEnv = loadEnv({
            ...envSource,
            REMI_TRANSPORT: 'http',
            HTTP_TOKEN: 'a'.repeat(32),
            HTTP_PUBLIC_URL: 'https://fleet.acme.test',
        })
        const base = deps({
            env: httpEnv.ok ? httpEnv.env : null,
            remi: remi({ getFleetConfig: async () => ({ ok: true, data: { ...config, transport: 'http' } }) }),
        })
        const warn = await runCheck({ ...base, httpProbe: async () => ({ status: 200, body: { bots: [{ bot_id: 'ACME-0001' }] } }) })
        assert.equal(rule(warn, 'C6')?.status, 'WARN')
        assert.match(rule(warn, 'C6')?.message ?? '', /does not prove that remi can reach you/)
        const short = await runCheck({ ...base, httpProbe: async () => ({ status: 200, body: { bots: [] } }) })
        assert.equal(rule(short, 'C6')?.status, 'FAIL', 'GET /bots must return every roster bot')
        const down = await runCheck({ ...base, httpProbe: async () => ({ status: 0, error: 'ECONNREFUSED' }) })
        assert.equal(rule(down, 'C6')?.status, 'FAIL')
    })
    it('C7: 403 on deliveries is a WARN, not a FAIL', async () => {
        const report = await runCheck(
            deps({ remi: remi({ listDeliveries: async () => ({ ok: false, status: 403, code: 'FORBIDDEN', message: '' }) }) }),
        )
        assert.equal(rule(report, 'C7')?.status, 'WARN')
    })
    it('C8 FAIL when the frozen samples do not validate', async () => {
        const report = await runCheck(deps({ parity: async () => ({ ok: false, detail: 'type-bot-state__botstate: door invalid' }) }))
        assert.equal(rule(report, 'C8')?.status, 'FAIL')
    })
    /**
     * Cross-task debt 1. `runParityInProcess` THROWS on a mis-synced clone (an expectation naming a
     * sample that is not on disk, a SOURCE.json with no `files`) instead of returning a failed
     * result. `efk check` is the partner's first contact with the kit: it must hand them the remedy.
     */
    it('C8 FAILs with the remedy when the parity runner THROWS, instead of taking the command down', async () => {
        const report = await runCheck(
            deps({
                parity: async () => {
                    throw new Error("ENOENT: no such file or directory, open 'samples/type-bot-state__botstate.json'")
                },
            }),
        )
        assert.equal(rule(report, 'C8')?.status, 'FAIL')
        assert.match(rule(report, 'C8')?.message ?? '', /restore it/)
        assert.match(rule(report, 'C8')?.message ?? '', /ENOENT/)
        assert.equal(report.exitCode, 1)
        // And the rest of the report still exists: one broken rule does not erase the other eight.
        assert.equal(report.rules.length, 9)
    })
    it('C9 builds one driver per roster bot, never starts them, and names the bot that is wrong', async () => {
        const built: string[] = []
        const started: string[] = []
        const rosterRemi = remi({ listFleetBots: async () => ({ ok: true, data: [mirror('ACME-0001'), mirror('ACME-0002')] }) })
        const driver = (botId: string) => {
            built.push(botId)
            const d = new FakeDriver(botId)
            d.start = async () => {
                started.push(botId)
            }
            // Only the second bot is misconfigured: a single probe driver with a made-up id would
            // have missed this entirely.
            if (botId === 'ACME-0002') d.caps = { has_door: true, supported_commands: ['navigate_to', 'cancel_navigation'] }
            return d
        }
        const report = await runCheck(deps({ remi: rosterRemi, config: { driver, fleet: { supportsCommandInterrupt: true } } }))
        assert.deepEqual(built, ['ACME-0001', 'ACME-0002'])
        assert.deepEqual(started, [], 'efk check is read-only: it does not open connections to a partner robot')
        assert.equal(rule(report, 'C9')?.status, 'WARN')
        assert.match(rule(report, 'C9')?.message ?? '', /ACME-0002: declares a door but not set_door/)
    })
    it('C9 FAILs on a wrong driver version and on a factory that throws', async () => {
        const v2 = () => {
            const d = new FakeDriver('ACME-0001')
            // biome-ignore lint/suspicious/noExplicitAny: forcing a wrong version
            ;(d as any).driverVersion = 2
            return d
        }
        assert.equal(
            rule(await runCheck(deps({ config: { driver: v2, fleet: { supportsCommandInterrupt: true } } })), 'C9')?.status,
            'FAIL',
        )
        const boom = () => {
            throw new Error('cannot reach the fleet API')
        }
        const thrown = await runCheck(deps({ config: { driver: boom as never, fleet: { supportsCommandInterrupt: true } } }))
        assert.equal(rule(thrown, 'C9')?.status, 'FAIL')
        assert.match(rule(thrown, 'C9')?.message ?? '', /cannot reach the fleet API/)
    })
    it('C9 WARNs about scenario overrides that name a bot the roster does not have', async () => {
        const driver = Object.assign((botId: string) => new FakeDriver(botId), { auditRoster: () => ['ACME-0009'] })
        const report = await runCheck(deps({ config: { driver, fleet: { supportsCommandInterrupt: true } } }))
        assert.equal(rule(report, 'C9')?.status, 'WARN')
        assert.match(rule(report, 'C9')?.message ?? '', /not in your roster: ACME-0009/)
    })
    /**
     * The whole product value of this command: a verdict a partner cannot act on is worth nothing.
     * Every rule that is not PASS must carry something to DO, and nothing printed may be a secret —
     * the .env behind this report holds an API key, a broker password and a bearer token.
     */
    it('every non-PASS rule carries a remedy, and no rule ever prints a secret', async () => {
        const secrets = { key: `live_sk_${'a'.repeat(48)}`, password: 'br0ker-s3cret', token: 'T'.repeat(40) }
        const env = loadEnv({ ...envSource, REMI_API_KEY: secrets.key, MQTT_PASSWORD: secrets.password, HTTP_TOKEN: secrets.token })
        const httpEnv = loadEnv({
            ...envSource,
            REMI_TRANSPORT: 'http',
            HTTP_TOKEN: secrets.token,
            HTTP_PUBLIC_URL: 'https://fleet.acme.test',
        })
        const blockedRoster = remi({
            listFleetBots: async () => ({
                ok: true,
                data: [
                    mirror('ACME-0001', { location_id: null, blocked_by: ['no_position', 'state_stale'] }),
                    mirror('ACME-0002', { location_id: 'L2' }),
                ],
            }),
        })
        const reports = await Promise.all([
            runCheck(deps({ env: env.ok ? env.env : null })),
            runCheck(deps({ env: null, envError: 'REMI_API_KEY: expected live_sk_ followed by 48 hex characters' })),
            runCheck(
                deps({
                    env: env.ok ? env.env : null,
                    demo: true,
                    mqttProbe: async () => ({ connack: false, grantedQos: -1, error: 'Connection refused: Not authorized' }),
                }),
            ),
            runCheck(
                deps({
                    env: env.ok ? env.env : null,
                    config: null,
                    configError: 'Cannot find module',
                    parity: async () => ({ ok: false, detail: 'SOURCE.json has no commit' }),
                }),
            ),
            // C3 FAIL (nothing registered) and C2 WARN (a contract the kit does not freeze).
            runCheck(
                deps({
                    env: env.ok ? env.env : null,
                    remi: remi({
                        getFleetConfig: async () => ({ ok: true, data: { ...config, contract_version: '2027-01' } }),
                        listFleetBots: async () => ({ ok: true, data: [] }),
                    }),
                }),
            ),
            // C3 WARN (unplaced, elsewhere) and C4 WARN (blocked_by), plus C5 WARN on a QoS downgrade.
            runCheck(
                deps({ env: env.ok ? env.env : null, remi: blockedRoster, mqttProbe: async () => ({ connack: true, grantedQos: 0 }) }),
            ),
            // C6 FAIL (nothing answers) and C7 WARN (no `delivery` scope) in http mode.
            runCheck(
                deps({
                    env: httpEnv.ok ? httpEnv.env : null,
                    remi: remi({
                        getFleetConfig: async () => ({ ok: true, data: { ...config, transport: 'http' } }),
                        listDeliveries: async () => ({ ok: false, status: 403, code: 'FORBIDDEN', message: '' }),
                    }),
                    httpProbe: async () => ({ status: 0, error: 'ECONNREFUSED' }),
                }),
            ),
        ])
        // What makes a verdict actionable: it names the thing to change, the party to chase, or
        // what to run. `Robot.com` counts on its own: "Robot.com has not registered your bots yet"
        // is the whole remedy for a rule whose fix is on our side of the provisioning, not theirs.
        const remedy =
            /\b(paste|copy|restore|update|unset|edit|expose|ask|tell|report|check|Robot\.com|see C[1-9]|efk|git pull|MQTT_|HTTP_|SANDBOX_|REMI_)/
        const flagged = new Set<string>()
        for (const report of reports) {
            for (const r of report.rules) {
                assert.ok(r.message.length > 0, `${r.id} says nothing`)
                if (r.status === 'FAIL' || r.status === 'WARN') {
                    flagged.add(r.id)
                    assert.match(r.message, remedy, `${r.id} is a verdict with nothing to act on: ${r.message}`)
                }
                for (const [name, value] of Object.entries(secrets)) {
                    assert.ok(!r.message.includes(value), `${r.id} leaked the ${name}`)
                    assert.ok(!r.message.includes(value.slice(0, 12)), `${r.id} leaked a prefix of the ${name}`)
                }
            }
            assert.ok(!formatReport(report).includes(secrets.password), 'the rendered report leaked the broker password')
        }
        // Coverage: every one of the nine rules was exercised in a state that asks the partner to do
        // something, so "carries a remedy" is a claim about all of them, not about the four that ran.
        assert.deepEqual([...flagged].sort(), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'])
    })
    it('formatReport renders one line per rule and a verdict', () => {
        const text = formatReport({ rules: [{ id: 'C1', status: 'PASS', message: '.env parses (mqtt mode)' }], exitCode: 0 })
        assert.equal(text, 'PASS C1  .env parses (mqtt mode)\nOK')
    })
})
