/**
 * `efk check`: the partner-side conformance (design §7). Nine rules, PASS / WARN / FAIL / SKIP, each
 * with the fix spelled out. Read-only: it never publishes state, never creates orders, never touches
 * remi. C5 connects with a DIAGNOSTIC client id so it never evicts a live bot. C6 is at best a WARN:
 * a request from this machine to its own public URL does not prove remi can reach it.
 *
 * NO SECRET REACHES A MESSAGE. The `.env` holds an API key, a broker password and a bearer token;
 * every rule below reports whether a credential is present and well formed, never its value. The one
 * credential-derived string that IS printed is `MQTT_USERNAME` (C2), which is not a secret: it is the
 * public half of the broker login and it encodes the namespace, which is the whole point of the rule.
 */
import type { KitConfig } from '../config'
import { hasBotIdPrefix, isValidBotId } from '../contract/ids'
import { fleetCheckClientId, fleetTopic } from '../contract/topics'
import { CONTRACT_VERSION } from '../contract/version'
import type { RemiClient } from '../remi/client'
import type { Env } from './env'

export type RuleId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'C9'
export type RuleStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP'
export type Rule = { id: RuleId; status: RuleStatus; message: string }
export type CheckReport = { rules: Rule[]; exitCode: 0 | 1 }

export type CheckDeps = {
    env: Env | null
    envError?: string
    remi: RemiClient
    config: KitConfig | null
    configError?: string
    mqttProbe: (opts: {
        url: string
        username: string
        password: string
        clientId: string
        commandTopicFilter: string
    }) => Promise<{ connack: boolean; grantedQos: number; error?: string }>
    httpProbe: (url: string, token: string) => Promise<{ status: number; body?: unknown; error?: string }>
    parity: () => Promise<{ ok: boolean; detail: string }>
    /** True when EFK_FAKE_REMI is on: nothing here talks to remi, and C2 has to say so. */
    demo: boolean
    now: () => number
    random: () => number
}

/** The ceiling remi enforces today. Not a schema bound — see fleetConfigResponseSchema. */
const MAX_BOTS_TODAY = 200

const BLOCKED_HELP: Record<string, string> = {
    disconnected: 'is `efk start` running? remi has no live connection/state for this bot',
    unavailable: 'the bot reports available: false (scenario, battery threshold, or the TUI toggle)',
    battery_below_minimum: 'battery below 20 %; 20 exactly is still eligible',
    no_position: 'no position received yet; a state without position is never published',
    no_location: 'Robot.com has not placed this bot in your sandbox location yet',
    state_stale: 'last state older than 60 s; check the publish loop and the broker link',
    retired: 'this bot was retired on the remi side',
}

/**
 * C8's parity call, which must not be able to take the command down with it.
 *
 * `runParityInProcess` (Task 2) THROWS rather than returning a failed result when an expectation
 * names a sample file that is not on disk, or when SOURCE.json has no `files` key — which is exactly
 * the shape of the mis-synced clone C8 exists to diagnose. Its own test catches the throw, so nothing
 * noticed. A partner running the very first command we ask them to run must get the remedy, not a
 * stack trace, so a throw becomes the same FAIL with the same remedy.
 */
async function runParity(parity: CheckDeps['parity']): Promise<{ ok: boolean; detail: string }> {
    try {
        return await parity()
    } catch (error) {
        return { ok: false, detail: `the parity check itself crashed: ${error instanceof Error ? error.message : String(error)}` }
    }
}

export async function runCheck(deps: CheckDeps): Promise<CheckReport> {
    const rules: Rule[] = []
    const add = (id: RuleId, status: RuleStatus, message: string) => rules.push({ id, status, message })

    let roster: string[] = []

    if (!deps.env) {
        add('C1', 'FAIL', `.env does not parse — copy the .env Robot.com sent you; ${deps.envError ?? 'unknown error'}`)
        for (const id of ['C2', 'C3', 'C4', 'C5', 'C6', 'C7'] as const) add(id, 'SKIP', 'needs a valid .env')
    } else {
        const env = deps.env
        // The .env parses, but one value is delivered separately and is therefore routinely missing.
        // This is a FAIL with the exact remedy, not a parse error: the file is not broken.
        const passwordMissing = env.REMI_TRANSPORT === 'mqtt' && !env.MQTT_PASSWORD
        if (passwordMissing)
            add('C1', 'FAIL', '`MQTT_PASSWORD` is empty: paste the broker credential Robot.com sent you separately (MQTT runbook, step 4)')
        else add('C1', 'PASS', `.env parses (${env.REMI_TRANSPORT} mode)`)

        const fleet = await deps.remi.getFleetConfig()
        if (deps.demo) {
            // EFK_FAKE_REMI answers everything from memory. Saying PASS here would be the single most
            // misleading line the kit can print: the partner would show it to us as evidence.
            add(
                'C2',
                'FAIL',
                'demo mode active (EFK_FAKE_REMI): nothing here talks to remi, every answer is invented — unset it before trusting any of this',
            )
            for (const id of ['C3', 'C4'] as const) add(id, 'SKIP', 'demo mode')
        } else if (!fleet.ok) {
            const remedy =
                fleet.status === 401
                    ? 'the API key is not valid'
                    : fleet.status === 403
                      ? 'the key does not carry the scope `fleet`'
                      : fleet.status === 404
                        ? 'Robot.com has not configured your fleet yet (FLEET_NOT_CONFIGURED)'
                        : `${fleet.status} ${fleet.code}: ${fleet.message}`
            add('C2', 'FAIL', `GET /api/v3/fleet → ${remedy}`)
            for (const id of ['C3', 'C4'] as const) add(id, 'SKIP', 'needs GET /api/v3/fleet')
        } else {
            const cfg = fleet.data
            // Every condition is evaluated and reported, not just the first one that trips: a partner
            // who fixes the transport mismatch and re-runs should not then discover the version
            // mismatch, and then the namespace one, one round trip at a time.
            const fails: string[] = []
            const warns: string[] = []
            if (cfg.transport !== env.REMI_TRANSPORT)
                fails.push(`remi expects transport ${cfg.transport}, your .env says ${env.REMI_TRANSPORT}`)
            if (env.REMI_TRANSPORT === 'mqtt' && env.MQTT_USERNAME) {
                // No new variable in the .env for this: the namespace is derivable from the credential
                // the partner already has (`fleet_<ns>`), and remi is the authority on the real value.
                const derived = env.MQTT_USERNAME.replace(/^fleet_/, '')
                if (derived !== cfg.namespace) {
                    fails.push(
                        `MQTT_USERNAME is \`${env.MQTT_USERNAME}\`, which implies namespace \`${derived}\`, but remi says your namespace is \`${cfg.namespace}\`: every topic and client id would be wrong`,
                    )
                }
            }
            if (cfg.contract_version !== CONTRACT_VERSION) {
                warns.push(
                    `remi is on contract ${cfg.contract_version}, this kit freezes ${CONTRACT_VERSION}: update the kit (git pull) or ask Robot.com which version they expect`,
                )
            }
            if (cfg.max_bots > MAX_BOTS_TODAY)
                warns.push(`max_bots is ${cfg.max_bots}, above the ${MAX_BOTS_TODAY} this kit has been exercised with; report anything odd`)
            if (env.REMI_TRANSPORT === 'http' && cfg.base_url && !cfg.base_url.startsWith('https://')) {
                warns.push(`remi has your base_url as ${cfg.base_url}, which is not https; ask Robot.com to update it`)
            }
            if (fails.length > 0) add('C2', 'FAIL', fails.join(' | '))
            else if (warns.length > 0) add('C2', 'WARN', warns.join(' | '))
            else
                add(
                    'C2',
                    'PASS',
                    `fleet ${cfg.namespace}, prefix ${cfg.bot_id_prefix}, ${cfg.transport}, max_bots ${cfg.max_bots}, contract ${cfg.contract_version}`,
                )

            const list = await deps.remi.listFleetBots()
            if (!list.ok) {
                add('C3', 'FAIL', `GET /api/v3/fleet/bots → ${list.status} ${list.code}`)
                add('C4', 'SKIP', 'needs the roster')
            } else {
                const bots = list.data
                roster = bots.map((b) => b.bot_id)
                const bad = bots.filter((b) => !isValidBotId(b.bot_id) || !hasBotIdPrefix(b.bot_id, cfg.bot_id_prefix)).map((b) => b.bot_id)
                const unplaced = bots.filter((b) => b.location_id === null).map((b) => b.bot_id)
                const elsewhere = bots
                    .filter((b) => b.location_id !== null && b.location_id !== env.SANDBOX_LOCATION_ID)
                    .map((b) => b.bot_id)
                const retired = bots.filter((b) => b.blocked_by.includes('retired')).map((b) => b.bot_id)
                // Same reasoning as C2: collect, then report. The old `else if` chain hid every problem
                // after the first, which on a fresh provisioning is exactly when there are several.
                const rosterFails: string[] = []
                const rosterWarns: string[] = []
                if (bots.length === 0) rosterFails.push('Robot.com has not registered your bots yet (0 bots)')
                if (bad.length)
                    rosterFails.push(
                        `bot ids outside the prefix/grammar: ${bad.join(', ')} — a provisioning bug on our side, tell Robot.com`,
                    )
                if (bots.length > cfg.max_bots)
                    rosterWarns.push(`${bots.length} bots but max_bots is ${cfg.max_bots}; only the first ${cfg.max_bots} will run`)
                if (unplaced.length) rosterWarns.push(`Robot.com has not placed ${unplaced.join(', ')} in your sandbox location yet`)
                if (elsewhere.length)
                    rosterWarns.push(
                        `${elsewhere.join(', ')} sit in another location than SANDBOX_LOCATION_ID; your test orders will not reach them`,
                    )
                if (retired.length) rosterWarns.push(`retired: ${retired.join(', ')}`)
                if (rosterFails.length > 0) add('C3', 'FAIL', rosterFails.join(' | '))
                else if (rosterWarns.length > 0) add('C3', 'WARN', rosterWarns.join(' | '))
                else add('C3', 'PASS', `${bots.length} bots registered and placed in ${env.SANDBOX_LOCATION_ID}`)

                const blocked = bots.filter((b) => b.blocked_by.length > 0)
                if (blocked.length === 0) add('C4', 'PASS', 'every bot is assignable')
                else
                    add(
                        'C4',
                        'WARN',
                        blocked
                            .map((b) => `${b.bot_id}: ${b.blocked_by.map((r) => `${r} (${BLOCKED_HELP[r] ?? r})`).join('; ')}`)
                            .join(' | '),
                    )
            }
        }

        if (env.REMI_TRANSPORT === 'mqtt' && passwordMissing) {
            // Connecting with an empty password would come back "not authorised" and send the partner
            // to check a credential they have not been given yet. C1 already said what to do.
            add('C5', 'SKIP', 'needs MQTT_PASSWORD (see C1)')
            add('C6', 'SKIP', 'http mode only')
        } else if (env.REMI_TRANSPORT === 'mqtt' && env.MQTT_HOST && env.MQTT_USERNAME && env.MQTT_PASSWORD) {
            const namespace = fleet.ok ? fleet.data.namespace : env.MQTT_USERNAME.replace(/^fleet_/, '')
            const probe = await deps.mqttProbe({
                url: `mqtts://${env.MQTT_HOST}:${env.MQTT_PORT}`,
                username: env.MQTT_USERNAME,
                password: env.MQTT_PASSWORD,
                clientId: fleetCheckClientId(namespace, deps.random),
                commandTopicFilter: fleetTopic(namespace, '+', 'command'),
            })
            if (!probe.connack) {
                const notAuth = /not authori/i.test(probe.error ?? '')
                add(
                    'C5',
                    'FAIL',
                    notAuth
                        ? `broker refused CONNECT (not authorised): check MQTT_USERNAME/MQTT_PASSWORD and that your namespace is ${namespace}. Fix it before retrying — repeated authentication failures get the client banned for a few minutes, so a loop of retries turns one wrong character into a broker that ignores you (contract page, "Failed logins are rate limited")`
                        : `no broker reply (${probe.error ?? 'timeout'}): no network to ${env.MQTT_HOST}, or the port is not 8883`,
                )
            } else if (probe.grantedQos !== 1)
                add(
                    'C5',
                    'WARN',
                    `broker downgraded the command subscription to QoS ${probe.grantedQos}; commands may be lost — the kit already subscribes at QoS 1, so the downgrade is the broker's: ask Robot.com to check the ACL on your credential`,
                )
            else add('C5', 'PASS', `CONNECT + SUBSCRIBE ok on mqtts://${env.MQTT_HOST}:${env.MQTT_PORT}`)
            add('C6', 'SKIP', 'http mode only')
        } else if (env.REMI_TRANSPORT === 'http' && env.HTTP_PUBLIC_URL && env.HTTP_TOKEN) {
            add('C5', 'SKIP', 'mqtt mode only')
            const probe = await deps.httpProbe(`${env.HTTP_PUBLIC_URL.replace(/\/$/, '')}/bots`, env.HTTP_TOKEN)
            if (probe.status === 0)
                add(
                    'C6',
                    'FAIL',
                    `your server is not reachable even from this machine (${probe.error}); expose HTTP_PORT with a tunnel or a deployment`,
                )
            else if (probe.status === 401) add('C6', 'FAIL', 'HTTP_TOKEN in the .env does not match the token the server runs with')
            else if (probe.status !== 200) add('C6', 'FAIL', `GET ${env.HTTP_PUBLIC_URL}/bots → ${probe.status}`)
            else {
                const bots = (probe.body as { bots?: unknown[] } | undefined)?.bots
                const expectedCount = roster.length > 0 ? roster.length : null
                if (!Array.isArray(bots) || (expectedCount !== null && bots.length < expectedCount)) {
                    add(
                        'C6',
                        'FAIL',
                        `GET /bots returned ${Array.isArray(bots) ? bots.length : 'no'} bots, the roster has ${expectedCount ?? '?'}: the contract requires every bot on every call. The kit only ever omits a bot that has NEVER had a position — check the log for the line naming them`,
                    )
                } else
                    add(
                        'C6',
                        'WARN',
                        `your server answered from this machine with ${bots.length} bots — this does not prove that remi can reach you (NAT, split DNS); the real check is remi calling you`,
                    )
            }
        } else {
            add('C5', 'SKIP', 'transport variables missing (see C1)')
            add('C6', 'SKIP', 'transport variables missing (see C1)')
        }

        const deliveries = await deps.remi.listDeliveries(1)
        if (deliveries.ok) add('C7', 'PASS', 'the key carries `delivery`: efk order is available')
        else if (deliveries.status === 403)
            add('C7', 'WARN', 'the key does not carry `delivery`; you can simulate but not create test orders — ask Robot.com')
        else add('C7', 'WARN', `GET /api/v3/delivery/ → ${deliveries.status} ${deliveries.code}`)
    }

    const parity = await runParity(deps.parity)
    add(
        'C8',
        parity.ok ? 'PASS' : 'FAIL',
        parity.ok
            ? `frozen samples validate (${parity.detail})`
            : `your copy of src/contract/ is modified or corrupt (${parity.detail}); restore it — this says nothing about the published page`,
    )

    /**
     * C9 inspects the REAL drivers: one per bot id in the roster, built exactly as `efk start` builds
     * them, and never started — `driverVersion` and `capabilities()` are pure reads, while `start()`
     * would open connections to a partner's robots from a command documented as read-only. A single
     * probe driver built with a made-up id (the old `EFK-CHECK`) checked a bot that does not exist,
     * so a factory that only misbehaves for a real id — the commonest way a per-bot lookup breaks —
     * passed. There is no "no origin" branch either: the origin comes from SANDBOX_CENTER_*, and a
     * `.env` without them never reaches here (C1 fails and `deps.env` is null).
     */
    if (!deps.config) add('C9', 'FAIL', `efk.config.ts did not load: ${deps.configError ?? 'unknown error'}`)
    else if (!deps.env) add('C9', 'SKIP', 'needs SANDBOX_CENTER_* from the .env')
    else if (roster.length === 0) add('C9', 'SKIP', 'needs the roster (see C3)')
    else {
        const origin = { lat: deps.env.SANDBOX_CENTER_LAT, lng: deps.env.SANDBOX_CENTER_LNG }
        const c9Fails: string[] = []
        const c9Warns: string[] = []
        for (const botId of roster) {
            try {
                const driver = deps.config.driver(botId, { origin })
                if (driver.driverVersion !== 1) {
                    c9Fails.push(`${botId}: driver implements version ${String(driver.driverVersion)}; update it to RobotDriver v1`)
                    continue
                }
                if (typeof driver.validateDestination !== 'function') {
                    c9Fails.push(`${botId}: driver lacks validateDestination (required in v1; use defaultValidateDestination)`)
                    continue
                }
                const caps = driver.capabilities()
                if (caps.hasDoor && !caps.supportedCommands.includes('set_door')) {
                    c9Warns.push(`${botId}: declares a door but not set_door — remi will send set_door and you will reject it`)
                }
            } catch (error) {
                c9Fails.push(`${botId}: driver factory threw: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
        // Scenario overrides keyed on a bot that is not in the roster do nothing at all, which looks
        // exactly like a kit that ignores its own scenarios. The bundled scenarios use the Acme cast.
        const strays = deps.config.driver.auditRoster?.(roster) ?? []
        if (strays.length > 0)
            c9Warns.push(
                `scenario overrides name bots that are not in your roster: ${strays.join(', ')} — edit the ids in the scenario to match yours`,
            )

        if (c9Fails.length > 0) add('C9', 'FAIL', c9Fails.join(' | '))
        else if (c9Warns.length > 0) add('C9', 'WARN', c9Warns.join(' | '))
        else
            add(
                'C9',
                'PASS',
                `driver v1 ok for all ${roster.length} bots; fleet.supportsCommandInterrupt = ${deps.config.fleet.supportsCommandInterrupt}`,
            )
    }

    return { rules, exitCode: rules.some((r) => r.status === 'FAIL') ? 1 : 0 }
}

export function formatReport(report: CheckReport): string {
    const width = Math.max(...report.rules.map((r) => r.id.length))
    return `${report.rules.map((r) => `${r.status.padEnd(4)} ${r.id.padEnd(width)}  ${r.message}`).join('\n')}\n${report.exitCode === 0 ? 'OK' : 'FAIL'}`
}
