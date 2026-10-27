import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FakeDriver } from '../core/fakes'
import type { RemiClient } from '../remi/client'
import { BLOCKED_HELP, formatReport, runCheck } from './check'
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
    it('C9 FAILs on a driver without navigate_to or cancel_navigation, which remi requires', async () => {
        const driver = (botId: string) => {
            const d = new FakeDriver(botId)
            d.caps = { has_door: true, supported_commands: ['navigate_to', 'set_door'] }
            return d
        }
        const report = await runCheck(deps({ config: { driver, fleet: { supportsCommandInterrupt: true } } }))
        assert.equal(rule(report, 'C9')?.status, 'FAIL')
        assert.match(rule(report, 'C9')?.message ?? '', /lacks cancel_navigation, which remi requires/)
    })
    it('C9 WARNs about scenario overrides that name a bot the roster does not have', async () => {
        const driver = Object.assign((botId: string) => new FakeDriver(botId), { auditRoster: () => ['ACME-0009'] })
        const report = await runCheck(deps({ config: { driver, fleet: { supportsCommandInterrupt: true } } }))
        assert.equal(rule(report, 'C9')?.status, 'WARN')
        assert.match(rule(report, 'C9')?.message ?? '', /not in your roster: ACME-0009/)
    })
    /**
     * The whole product value of this command: a verdict a partner cannot act on is worth nothing.
     *
     * THE GUARD IS THE TYPE, NOT A REGEX. A FAIL or a WARN is built from `Finding`s, each of which
     * has to carry a `remedy`, so the check below is an exact one — `remedy` is non-empty — rather
     * than a search for remedy-ish words. The word search let three messages through twice:
     * `retired: <bot>` passed because `retire` is a substring of `retired`, `unavailable` because
     * `report` is a substring of `reports`, and `battery_below_minimum`/`no_position` because they
     * only ever appeared joined to a better-written sibling.
     *
     * THE CORPUS IS STILL THE POINT. One case per FAIL/WARN branch `check.ts` can emit, named after
     * the branch it reaches, so a new branch is a new row here. The same pass asserts that nothing
     * printed is a secret: the `.env` behind these reports holds an API key, a broker password and a
     * bearer token.
     */
    const secrets = { key: `live_sk_${'a'.repeat(48)}`, password: 'br0ker-s3cret', token: 'T'.repeat(40) }
    const secretSource = { ...envSource, REMI_API_KEY: secrets.key, MQTT_PASSWORD: secrets.password, HTTP_TOKEN: secrets.token }
    const envOf = (source: Record<string, string>) => {
        const parsed = loadEnv(source)
        return parsed.ok ? parsed.env : null
    }
    const mqttEnv = envOf(secretSource)
    const httpEnv = envOf({ ...secretSource, REMI_TRANSPORT: 'http', HTTP_PUBLIC_URL: 'https://fleet.acme.test' })
    const httpFleet = (over: Partial<RemiClient> = {}) =>
        remi({ getFleetConfig: async () => ({ ok: true, data: { ...config, transport: 'http' } }), ...over })
    const roster = (...bots: Array<ReturnType<typeof mirror>>) => remi({ listFleetBots: async () => ({ ok: true, data: bots }) })
    const badDriver = (make: (botId: string) => FakeDriver) => ({ driver: make, fleet: { supportsCommandInterrupt: true } })

    /** One entry per branch that can produce a FAIL or a WARN. Keep it exhaustive. */
    const corpus: Array<[string, Partial<Parameters<typeof runCheck>[0]>]> = [
        ['C1 unparseable .env', { env: null, envError: 'REMI_API_KEY: expected live_sk_ followed by 48 hex characters' }],
        ['C1 empty MQTT_PASSWORD', { env: envOf({ ...secretSource, MQTT_PASSWORD: '' }) }],
        ['C2 demo mode', { demo: true }],
        [
            'C2 remi unreachable',
            { remi: remi({ getFleetConfig: async () => ({ ok: false, status: 0, code: 'NETWORK', message: 'fetch failed' }) }) },
        ],
        ['C2 401', { remi: remi({ getFleetConfig: async () => ({ ok: false, status: 401, code: 'UNAUTHORIZED', message: '' }) }) }],
        ['C2 403', { remi: remi({ getFleetConfig: async () => ({ ok: false, status: 403, code: 'FORBIDDEN', message: '' }) }) }],
        ['C2 404', { remi: remi({ getFleetConfig: async () => ({ ok: false, status: 404, code: 'FLEET_NOT_CONFIGURED', message: '' }) }) }],
        [
            'C2 unexpected status',
            { remi: remi({ getFleetConfig: async () => ({ ok: false, status: 502, code: 'BAD_GATEWAY', message: 'upstream said no' }) }) },
        ],
        ['C2 transport mismatch', { remi: httpFleet() }],
        [
            'C2 namespace mismatch',
            { remi: remi({ getFleetConfig: async () => ({ ok: true, data: { ...config, namespace: 'other_partner' } }) }) },
        ],
        [
            'C2 contract drift + max_bots above the tested ceiling',
            { remi: remi({ getFleetConfig: async () => ({ ok: true, data: { ...config, contract_version: '2027-01', max_bots: 500 } }) }) },
        ],
        [
            'C2 base_url not https',
            {
                env: httpEnv,
                remi: httpFleet({
                    getFleetConfig: async () => ({ ok: true, data: { ...config, transport: 'http', base_url: 'http://fleet.acme.test' } }),
                }),
            },
        ],
        [
            'C3 roster call failed',
            { remi: remi({ listFleetBots: async () => ({ ok: false, status: 500, code: 'INTERNAL', message: '' }) }) },
        ],
        ['C3 no bots registered', { remi: roster() }],
        ['C3 ids outside the grammar', { remi: roster(mirror('acme/1')) }],
        [
            'C3 more bots than max_bots',
            {
                remi: remi({
                    getFleetConfig: async () => ({ ok: true, data: { ...config, max_bots: 1 } }),
                    listFleetBots: async () => ({ ok: true, data: [mirror('ACME-0001'), mirror('ACME-0002')] }),
                }),
            },
        ],
        [
            'C3 unplaced + elsewhere + retired, C4 blocked_by',
            {
                remi: roster(
                    mirror('ACME-0001', { location_id: null, blocked_by: ['no_position', 'state_stale'] }),
                    mirror('ACME-0002', { location_id: 'L2' }),
                    mirror('ACME-0003', { blocked_by: ['retired'] }),
                ),
            },
        ],
        ['C5 not authorised', { mqttProbe: async () => ({ connack: false, grantedQos: -1, error: 'Connection refused: Not authorized' }) }],
        ['C5 no broker reply', { mqttProbe: async () => ({ connack: false, grantedQos: -1, error: 'timeout' }) }],
        ['C5 QoS downgrade', { mqttProbe: async () => ({ connack: true, grantedQos: 0 }) }],
        ['C6 nothing answers', { env: httpEnv, remi: httpFleet(), httpProbe: async () => ({ status: 0, error: 'ECONNREFUSED' }) }],
        ['C6 token mismatch', { env: httpEnv, remi: httpFleet(), httpProbe: async () => ({ status: 401 }) }],
        ['C6 some other status', { env: httpEnv, remi: httpFleet(), httpProbe: async () => ({ status: 503 }) }],
        ['C6 short roster', { env: httpEnv, remi: httpFleet(), httpProbe: async () => ({ status: 200, body: { bots: [] } }) }],
        [
            'C6 reachable, which is still only a WARN',
            { env: httpEnv, remi: httpFleet(), httpProbe: async () => ({ status: 200, body: { bots: [{ bot_id: 'ACME-0001' }] } }) },
        ],
        [
            'C7 no delivery scope',
            { remi: remi({ listDeliveries: async () => ({ ok: false, status: 403, code: 'FORBIDDEN', message: '' }) }) },
        ],
        [
            'C7 delivery probe failed',
            { remi: remi({ listDeliveries: async () => ({ ok: false, status: 500, code: 'INTERNAL', message: '' }) }) },
        ],
        ['C8 samples do not validate', { parity: async () => ({ ok: false, detail: 'type-bot-state__botstate: door invalid' }) }],
        ['C9 config did not load', { config: null, configError: 'Cannot find module' }],
        [
            'C9 wrong driver version',
            {
                config: badDriver((botId) => {
                    const d = new FakeDriver(botId)
                    // biome-ignore lint/suspicious/noExplicitAny: forcing a wrong version
                    ;(d as any).driverVersion = 2
                    return d
                }),
            },
        ],
        [
            'C9 driver without validateDestination',
            {
                config: badDriver((botId) => {
                    const d = new FakeDriver(botId)
                    // biome-ignore lint/suspicious/noExplicitAny: removing a required v1 method
                    ;(d as any).validateDestination = undefined
                    return d
                }),
            },
        ],
        [
            'C9 factory throws',
            {
                config: badDriver(() => {
                    throw new Error('cannot reach the fleet API')
                }),
            },
        ],
        [
            'C9 driver without a required command',
            {
                config: badDriver((botId) => {
                    const d = new FakeDriver(botId)
                    d.caps = { has_door: false, supported_commands: ['navigate_to'] }
                    return d
                }),
            },
        ],
        [
            'C9 door without set_door',
            {
                config: badDriver((botId) => {
                    const d = new FakeDriver(botId)
                    d.caps = { has_door: true, supported_commands: ['navigate_to', 'cancel_navigation'] }
                    return d
                }),
            },
        ],
        [
            'C9 scenario overrides outside the roster',
            {
                config: {
                    driver: Object.assign((botId: string) => new FakeDriver(botId), { auditRoster: () => ['ACME-0009'] }),
                    fleet: { supportsCommandInterrupt: true },
                },
            },
        ],
    ]

    it('every FAIL and WARN the command can emit carries a remedy, and none of them prints a secret', async () => {
        const flagged = new Set<string>()
        for (const [name, over] of corpus) {
            const report = await runCheck(deps({ env: mqttEnv, ...over }))
            for (const r of report.rules) {
                assert.ok(r.message.length > 0, `${name}: ${r.id} says nothing`)
                if (r.status === 'FAIL' || r.status === 'WARN') {
                    flagged.add(r.id)
                    assert.ok((r.remedy ?? '').trim().length > 0, `${name}: ${r.id} is a verdict with nothing to act on — "${r.message}"`)
                    // The remedy is not a field nobody reads: it is what the partner is shown.
                    assert.ok(r.message.includes(r.remedy.split(' | ')[0] ?? ''), `${name}: ${r.id} does not show its own remedy`)
                } else {
                    assert.equal(r.remedy, undefined, `${name}: ${r.id} is ${r.status} and cannot have a remedy`)
                }
                for (const [secret, value] of Object.entries(secrets)) {
                    assert.ok(!r.message.includes(value), `${name}: ${r.id} leaked the ${secret}`)
                    assert.ok(!r.message.includes(value.slice(0, 12)), `${name}: ${r.id} leaked a prefix of the ${secret}`)
                }
            }
            assert.ok(!formatReport(report).includes(secrets.password), `${name}: the rendered report leaked the broker password`)
        }
        // Coverage: every one of the nine rules was exercised in a state that asks the partner to do
        // something, so "carries a remedy" is a claim about all of them, not about the ones that ran.
        assert.deepEqual([...flagged].sort(), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'])
    })
    /**
     * IN ISOLATION, one reason at a time. The joining is what hid the holes: a bot blocked for four
     * reasons renders them in one line, so a reason with no remedy rode along on a sibling that had
     * one and no test ever saw it alone. Every reason the kit knows now gets its own roster, its own
     * report and its own assertion — and the table itself is checked, so a reason added to
     * `BLOCKED_HELP` without a remedy fails before it is ever rendered.
     */
    describe('C4, one blocked_by reason at a time', () => {
        for (const [reason, help] of Object.entries(BLOCKED_HELP)) {
            it(`${reason} explains itself and says what to do`, async () => {
                assert.ok(help.text.trim().length > 0, 'the cause is empty')
                assert.ok(help.remedy.trim().length > 0, 'the reason has no remedy')
                const report = await runCheck(
                    deps({
                        remi: remi({
                            listFleetBots: async () => ({
                                ok: true,
                                data: [mirror('ACME-0001', { assignable: false, blocked_by: [reason] })],
                            }),
                        }),
                    }),
                )
                const c4 = rule(report, 'C4')
                assert.equal(c4?.status, 'WARN')
                assert.ok((c4?.remedy ?? '').includes(help.remedy), `C4 dropped the remedy for ${reason}`)
                assert.equal(c4?.message, `ACME-0001: ${reason} (${help.text} ${help.remedy})`)
            })
        }
        it('a reason remi invents tomorrow is named as unknown, not printed twice', async () => {
            const report = await runCheck(
                deps({
                    remi: remi({
                        listFleetBots: async () => ({ ok: true, data: [mirror('ACME-0001', { blocked_by: ['brand_new_reason'] })] }),
                    }),
                }),
            )
            assert.equal(
                rule(report, 'C4')?.message,
                'ACME-0001: brand_new_reason (a reason this kit does not know yet — ask Robot.com what it means)',
            )
            assert.ok((rule(report, 'C4')?.remedy ?? '').length > 0)
        })
    })
    /**
     * The same holes on the C3 side: four roster warnings share one line, and `retired:` shipped
     * with nothing to act on because it never appeared alone.
     */
    describe('C3, one roster warning at a time', () => {
        const cases: Array<[string, ReturnType<typeof mirror>[], RegExp]> = [
            ['unplaced', [mirror('ACME-0001', { location_id: null })], /^Robot\.com has not placed ACME-0001 /],
            ['elsewhere', [mirror('ACME-0001', { location_id: 'L2' })], /^ACME-0001 sit in another location /],
            ['retired', [mirror('ACME-0001', { blocked_by: ['retired'] })], /^retired: ACME-0001 /],
        ]
        for (const [name, bots, shape] of cases) {
            it(`${name} alone still says what to do`, async () => {
                const report = await runCheck(deps({ remi: remi({ listFleetBots: async () => ({ ok: true, data: bots }) }) }))
                const c3 = rule(report, 'C3')
                assert.equal(c3?.status, 'WARN')
                assert.match(c3?.message ?? '', shape)
                assert.ok((c3?.remedy ?? '').trim().length > 0, `${name} is a warning with nothing to act on`)
                assert.ok(!(c3?.message ?? '').includes(' | '), 'this case must be the ONLY warning, or it is not isolated')
            })
        }
        it('over the cap, alone', async () => {
            const report = await runCheck(
                deps({
                    remi: remi({
                        getFleetConfig: async () => ({ ok: true, data: { ...config, max_bots: 1 } }),
                        listFleetBots: async () => ({ ok: true, data: [mirror('ACME-0001'), mirror('ACME-0002')] }),
                    }),
                }),
            )
            const c3 = rule(report, 'C3')
            assert.equal(c3?.status, 'WARN')
            assert.ok(!(c3?.message ?? '').includes(' | '), 'this case must be the ONLY warning, or it is not isolated')
            assert.ok((c3?.remedy ?? '').trim().length > 0)
        })
    })
    /**
     * Finding 1 of fix round 1, and the worst defect this command could have. In demo mode every
     * remi answer is invented, so a PASS is a lie a partner will act on — C2 says so loudly, and C7
     * used to say the opposite two lines later, from the same fake.
     */
    it('demo mode never emits a PASS: nothing it could pass on was verified', async () => {
        const report = await runCheck(deps({ demo: true }))
        assert.deepEqual(
            report.rules.filter((r) => r.status === 'PASS').map((r) => r.id),
            ['C1', 'C5', 'C8'],
            'only the rules that do NOT ask remi anything may pass in demo mode',
        )
        assert.equal(rule(report, 'C7')?.status, 'SKIP')
        assert.equal(rule(report, 'C7')?.message, 'demo mode')
        for (const id of ['C3', 'C4', 'C7'] as const) {
            assert.equal(rule(report, id)?.status, 'SKIP', `${id} must not answer from the in-memory fake`)
        }
    })
    it('formatReport renders one line per rule and a verdict', () => {
        const text = formatReport({ rules: [{ id: 'C1', status: 'PASS', message: '.env parses (mqtt mode)' }], exitCode: 0 })
        assert.equal(text, 'PASS C1  .env parses (mqtt mode)\nOK')
    })
})
