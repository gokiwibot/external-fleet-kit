/**
 * `efk check`: the partner-side conformance. Nine rules, PASS / WARN / FAIL / SKIP, each
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
import { selectRoster } from '../core/fleet-manager'
import type { RemiClient } from '../remi/client'
import { type Env, sandboxOrigin } from './env'

export type RuleId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'C9'
export type RuleStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP'

/**
 * One thing this command has to say: what is wrong (`text`) and what to DO about it (`remedy`), as
 * two fields rather than one sentence a reader has to search for a next step inside.
 *
 * The remedy used to live in the prose, guarded by a test that looked for remedy-ish WORDS. That
 * guard admitted weak messages twice — `retired: ACME-0003` passed because `retire` is a substring
 * of `retired`, `unavailable` because `report` is a substring of `reports`, and two more rode along
 * inside a `join(' | ')` with a well-written sibling. A keyword cannot tell a remedy from a word
 * that sounds like one. A required field can: a finding with no remedy does not compile.
 */
export type Finding = { text: string; remedy: string }

/**
 * A rule's verdict. FAIL and WARN carry the remedy they were built from; PASS and SKIP have nothing
 * to remedy and are typed so they cannot claim one. `message` is the line a partner reads — always
 * the composition of the findings, never hand-written for a FAIL or a WARN.
 */
export type Rule =
    | { id: RuleId; status: 'PASS' | 'SKIP'; message: string; remedy?: undefined }
    | { id: RuleId; status: 'FAIL' | 'WARN'; message: string; remedy: string }
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

/**
 * Why remi will not assign work to a bot, and what the partner does about it — one `Finding` per
 * reason, each tested on its own (`check.test.ts`). They used to be single strings joined into one
 * C4 line, which is how three of them shipped with no remedy at all: a reason only ever appeared
 * next to a better-written sibling, so nothing noticed.
 */
export const BLOCKED_HELP: Record<string, Finding> = {
    disconnected: { text: 'remi has no live connection or state for this bot —', remedy: 'is `efk start` running, and did it connect?' },
    unavailable: {
        text: 'the bot reports available: false —',
        remedy: 'check the scenario, the battery threshold, or the TUI toggle (`a`) that set it',
    },
    battery_below_minimum: {
        text: "battery below 20 %, which is remi's floor and not something you can change (20 exactly is still eligible) —",
        remedy: 'in the simulator, raise `battery.startPct` or drop `drainPctPerKm` in your scenario; with real robots, charge it',
    },
    no_position: {
        text: 'no position received yet, and a state without position is never published —',
        remedy: "make your driver's snapshot return a position for this bot; `efk start` logs the bots it is holding back",
    },
    no_location: { text: 'Robot.com has not placed this bot in your sandbox location yet —', remedy: 'ask Robot.com to place it' },
    state_stale: { text: 'last state older than 60 s;', remedy: 'check the publish loop and the broker link' },
    retired: {
        text: 'this bot was retired on the remi side and will never be assignable —',
        remedy: 'drop it from your test runs, or ask Robot.com to un-retire it',
    },
}

/** A reason remi has added since this kit was released: say so, rather than printing the code twice. */
const blockedHelp = (reason: string): Finding =>
    BLOCKED_HELP[reason] ?? { text: 'a reason this kit does not know yet —', remedy: 'ask Robot.com what it means' }

/**
 * C8's parity call, which must not be able to take the command down with it.
 *
 * `runParityInProcess` used to THROW rather than return a failed result when an expectation named a
 * sample file that was not on disk, or when SOURCE.json had no `files` key — exactly the shape of the
 * mis-synced clone C8 exists to diagnose. That is fixed at the root now (the runner reports), and
 * this stays as a belt: `parity` is an injected dependency, so the next implementation of it — the
 * real probe, a partner's fork — must not be able to take the command down either. A partner running
 * the very first command we ask them to run gets the remedy, never a stack trace.
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
    /** PASS and SKIP: a verdict with nothing to act on, which is the only reason they may skip a remedy. */
    const add = (id: RuleId, status: 'PASS' | 'SKIP', message: string) => rules.push({ id, status, message })
    /**
     * FAIL and WARN: built from findings, never from a bare string, so the remedy cannot be
     * forgotten or diluted into the prose. The composition lives HERE and not in `formatReport`
     * because a rule that reports several things interleaves them — `text remedy | text remedy` —
     * and composing at render time would either reorder the partner's line or lose the pairing.
     * Composing at construction also means every consumer of `message` gets the remedy, not only
     * the one renderer.
     */
    const flag = (id: RuleId, status: 'FAIL' | 'WARN', ...findings: Finding[]) =>
        rules.push({
            id,
            status,
            message: findings.map((f) => `${f.text} ${f.remedy}`).join(' | '),
            remedy: findings.map((f) => f.remedy).join(' | '),
        })

    let roster: string[] = []
    /**
     * remi's `fleet_serial` per bot, so C9 builds drivers exactly as `start` does. Without it the
     * preflight resolves a DIFFERENT serial from the one production will use for a mapped bot, and
     * a diagnostic that disagrees with the real startup is worse than no diagnostic.
     */
    let fleetSerials = new Map<string, string | null>()

    if (!deps.env) {
        flag('C1', 'FAIL', {
            text: '.env does not parse —',
            remedy: `copy the .env Robot.com sent you; ${deps.envError ?? 'unknown error'}`,
        })
        for (const id of ['C2', 'C3', 'C4', 'C5', 'C6', 'C7'] as const) add(id, 'SKIP', 'needs a valid .env')
    } else {
        const env = deps.env
        // The .env parses, but one value is delivered separately and is therefore routinely missing.
        // This is a FAIL with the exact remedy, not a parse error: the file is not broken.
        const passwordMissing = env.REMI_TRANSPORT === 'mqtt' && !env.MQTT_PASSWORD
        if (passwordMissing)
            flag('C1', 'FAIL', {
                text: '`MQTT_PASSWORD` is empty:',
                remedy: 'paste the broker credential Robot.com sent you separately (MQTT runbook, step 4)',
            })
        else add('C1', 'PASS', `.env parses (${env.REMI_TRANSPORT} mode)`)

        const fleet = await deps.remi.getFleetConfig()
        if (deps.demo) {
            // EFK_FAKE_REMI answers everything from memory. Saying PASS here would be the single most
            // misleading line the kit can print: the partner would show it to us as evidence.
            flag('C2', 'FAIL', {
                text: 'demo mode active (EFK_FAKE_REMI): nothing here talks to remi, every answer is invented —',
                remedy: 'unset it before trusting any of this',
            })
            for (const id of ['C3', 'C4'] as const) add(id, 'SKIP', 'demo mode')
        } else if (!fleet.ok) {
            // Each status says what happened AND what to do; the 401/403 texts are the brief's wording
            // and keep it, with the action they were missing added as the remedy.
            const cause: Finding =
                fleet.status === 0
                    ? {
                          text: `remi is not reachable from this machine (${fleet.message}):`,
                          remedy: 'check REMI_API_URL and your network',
                      }
                    : fleet.status === 401
                      ? {
                            text: 'the API key is not valid:',
                            remedy: 'copy REMI_API_KEY again from the .env Robot.com sent you, in case two fleets got mixed up',
                        }
                      : fleet.status === 403
                        ? { text: 'the key does not carry the scope `fleet`:', remedy: 'ask Robot.com to reissue it with that scope' }
                        : fleet.status === 404
                          ? {
                                text: 'Robot.com has not configured your fleet yet (FLEET_NOT_CONFIGURED):',
                                remedy: 'ask Robot.com to finish provisioning before you run anything else',
                            }
                          : {
                                text: `${fleet.status} ${fleet.code}: ${fleet.message} — an answer this kit does not know how to read;`,
                                remedy: 'retry, and if it persists send Robot.com this whole line together with your REMI_API_URL',
                            }
            flag('C2', 'FAIL', { text: `GET /api/v3/fleet → ${cause.text}`, remedy: cause.remedy })
            for (const id of ['C3', 'C4'] as const) add(id, 'SKIP', 'needs GET /api/v3/fleet')
        } else {
            const cfg = fleet.data
            // Every condition is evaluated and reported, not just the first one that trips: a partner
            // who fixes the transport mismatch and re-runs should not then discover the version
            // mismatch, and then the namespace one, one round trip at a time.
            const fails: Finding[] = []
            const warns: Finding[] = []
            if (cfg.transport !== env.REMI_TRANSPORT) {
                fails.push({
                    text: `remi expects transport ${cfg.transport}, your .env says ${env.REMI_TRANSPORT}:`,
                    remedy: `set REMI_TRANSPORT to \`${cfg.transport}\`, or ask Robot.com to switch your fleet to ${env.REMI_TRANSPORT} — the two have to agree before anything else works`,
                })
            }
            if (env.REMI_TRANSPORT === 'mqtt' && env.MQTT_USERNAME) {
                // No new variable in the .env for this: the namespace is derivable from the credential
                // the partner already has (`fleet_<ns>`), and remi is the authority on the real value.
                const derived = env.MQTT_USERNAME.replace(/^fleet_/, '')
                if (derived !== cfg.namespace) {
                    fails.push({
                        text: `MQTT_USERNAME is \`${env.MQTT_USERNAME}\`, which implies namespace \`${derived}\`, but remi says your namespace is \`${cfg.namespace}\`: every topic and client id would be wrong —`,
                        remedy: 'check you were sent the credentials for THIS fleet, and ask Robot.com which of the two namespaces is the real one before changing either',
                    })
                }
            }
            if (cfg.contract_version !== CONTRACT_VERSION) {
                warns.push({
                    text: `remi is on contract ${cfg.contract_version}, this kit freezes ${CONTRACT_VERSION}:`,
                    remedy: 'update the kit (git pull) or ask Robot.com which version they expect',
                })
            }
            if (cfg.max_bots > MAX_BOTS_TODAY)
                warns.push({
                    text: `max_bots is ${cfg.max_bots}, above the ${MAX_BOTS_TODAY} this kit has been exercised with;`,
                    remedy: 'report anything odd',
                })
            if (env.REMI_TRANSPORT === 'http' && cfg.base_url && !cfg.base_url.startsWith('https://')) {
                warns.push({ text: `remi has your base_url as ${cfg.base_url}, which is not https;`, remedy: 'ask Robot.com to update it' })
            }
            if (fails.length > 0) flag('C2', 'FAIL', ...fails)
            else if (warns.length > 0) flag('C2', 'WARN', ...warns)
            else
                add(
                    'C2',
                    'PASS',
                    `fleet ${cfg.namespace}, prefix ${cfg.bot_id_prefix}, ${cfg.transport}, max_bots ${cfg.max_bots}, contract ${cfg.contract_version}`,
                )

            const list = await deps.remi.listFleetBots()
            if (!list.ok) {
                flag('C3', 'FAIL', {
                    text: `GET /api/v3/fleet/bots → ${list.status} ${list.code} — the same key just read your fleet, so this is not the key:`,
                    remedy: 'retry, and if it persists send Robot.com this line',
                })
                add('C4', 'SKIP', 'needs the roster')
            } else {
                const bots = list.data
                // The SAME selection `efk start` makes, not a second opinion: retired rows out, cap
                // applied, mapping gate evaluated on what is actually driven. A preflight that
                // disagrees with the start is worse than no preflight — it passed a roster the start
                // parks, and failed on a retired bot whose serial its live replacement legitimately
                // reuses.
                const selection = selectRoster(bots, {
                    requiresFleetSerial: cfg.requires_fleet_serial ?? false,
                    maxBots: cfg.max_bots,
                })
                roster = selection.serve.map((b) => b.botId)
                fleetSerials = new Map(selection.serve.map((b) => [b.botId, b.fleetSerial]))
                const bad = bots.filter((b) => !isValidBotId(b.bot_id) || !hasBotIdPrefix(b.bot_id, cfg.bot_id_prefix)).map((b) => b.bot_id)
                const unplaced = bots.filter((b) => b.location_id === null).map((b) => b.bot_id)
                // Only meaningful when there IS a sandbox to compare against. With SANDBOX_LOCATION_ID
                // unset — the normal state of a production fleet — every placed bot would otherwise
                // be reported as sitting somewhere else, which is a warning about nothing.
                const elsewhere =
                    env.SANDBOX_LOCATION_ID === undefined
                        ? []
                        : bots.filter((b) => b.location_id !== null && b.location_id !== env.SANDBOX_LOCATION_ID).map((b) => b.bot_id)
                const retired = bots.filter((b) => b.blocked_by.includes('retired')).map((b) => b.bot_id)
                // Same reasoning as C2: collect, then report. The old `else if` chain hid every problem
                // after the first, which on a fresh provisioning is exactly when there are several.
                const rosterFails: Finding[] = []
                const rosterWarns: Finding[] = []
                if (bots.length === 0)
                    rosterFails.push({
                        text: 'Robot.com has not registered your bots yet (0 bots) —',
                        remedy: 'ask Robot.com to register them; there is nothing to change on your side',
                    })
                if (selection.unmapped.length)
                    rosterFails.push({
                        text: `this fleet requires fleet_serial and these have none: ${selection.unmapped.join(', ')} — efk start will run idle and drive nothing —`,
                        remedy: 'ask Robot.com to set each bot\u2019s fleet_serial to the id your own system uses for that robot',
                    })
                if (bad.length)
                    rosterFails.push({
                        text: `bot ids outside the prefix/grammar: ${bad.join(', ')} —`,
                        remedy: 'a provisioning bug on our side, tell Robot.com',
                    })
                if (bots.length > cfg.max_bots)
                    rosterWarns.push({
                        text: `${bots.length} bots but max_bots is ${cfg.max_bots}; only the first ${cfg.max_bots} will run —`,
                        remedy: 'ask Robot.com to raise max_bots, or retire the bots you are not testing with',
                    })
                if (unplaced.length)
                    rosterWarns.push({
                        text: `Robot.com has not placed ${unplaced.join(', ')} in your sandbox location yet —`,
                        remedy: 'ask Robot.com to place them; an order never reaches a bot with no location',
                    })
                if (elsewhere.length)
                    rosterWarns.push({
                        text: `${elsewhere.join(', ')} sit in another location than SANDBOX_LOCATION_ID; your test orders will not reach them —`,
                        remedy: 'check SANDBOX_LOCATION_ID is the sandbox Robot.com gave you, or ask them to move the bots',
                    })
                if (retired.length)
                    rosterWarns.push({
                        text: `retired: ${retired.join(', ')} —`,
                        remedy: 'these will never be assignable; drop them from your test runs, or ask Robot.com to un-retire them',
                    })
                if (rosterFails.length > 0) flag('C3', 'FAIL', ...rosterFails)
                else if (rosterWarns.length > 0) flag('C3', 'WARN', ...rosterWarns)
                else
                    add(
                        'C3',
                        'PASS',
                        env.SANDBOX_LOCATION_ID === undefined
                            ? `${bots.length} bots registered`
                            : `${bots.length} bots registered and placed in ${env.SANDBOX_LOCATION_ID}`,
                    )

                const blocked = bots.filter((b) => b.blocked_by.length > 0)
                if (blocked.length === 0) add('C4', 'PASS', 'every bot is assignable')
                else {
                    // One finding per BOT, whose remedy is that bot's reasons with the fix for each
                    // one beside it — so the rendered line keeps today's shape and no reason can be
                    // listed without saying what to do about it.
                    flag(
                        'C4',
                        'WARN',
                        ...blocked.map((b) => ({
                            text: `${b.bot_id}:`,
                            remedy: b.blocked_by
                                .map((r) => {
                                    const help = blockedHelp(r)
                                    return `${r} (${help.text} ${help.remedy})`
                                })
                                .join('; '),
                        })),
                    )
                }
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
                flag(
                    'C5',
                    'FAIL',
                    notAuth
                        ? {
                              text: 'broker refused CONNECT (not authorised):',
                              remedy: `check MQTT_USERNAME/MQTT_PASSWORD and that your namespace is ${namespace}. Fix it before retrying — repeated authentication failures get the client banned for a few minutes, so a loop of retries turns one wrong character into a broker that ignores you (contract page, "Failed logins are rate limited")`,
                          }
                        : {
                              text: `no broker reply (${probe.error ?? 'timeout'}):`,
                              remedy: `check there is a route from this machine to ${env.MQTT_HOST} and that MQTT_PORT is 8883`,
                          },
                )
            } else if (probe.grantedQos !== 1)
                flag('C5', 'WARN', {
                    text: `broker downgraded the command subscription to QoS ${probe.grantedQos}; commands may be lost — the kit already subscribes at QoS 1, so the downgrade is the broker's:`,
                    remedy: 'ask Robot.com to check the ACL on your credential',
                })
            else add('C5', 'PASS', `CONNECT + SUBSCRIBE ok on mqtts://${env.MQTT_HOST}:${env.MQTT_PORT}`)
            add('C6', 'SKIP', 'http mode only')
        } else if (env.REMI_TRANSPORT === 'http' && env.HTTP_PUBLIC_URL && env.HTTP_TOKEN) {
            add('C5', 'SKIP', 'mqtt mode only')
            const probe = await deps.httpProbe(`${env.HTTP_PUBLIC_URL.replace(/\/$/, '')}/bots`, env.HTTP_TOKEN)
            if (probe.status === 0)
                flag('C6', 'FAIL', {
                    text: `your server is not reachable even from this machine (${probe.error});`,
                    remedy: 'expose HTTP_PORT with a tunnel or a deployment',
                })
            else if (probe.status === 401)
                flag('C6', 'FAIL', {
                    text: 'HTTP_TOKEN in the .env does not match the token the server runs with —',
                    remedy: "restart `efk start` with this .env, or put the running server's token into it",
                })
            else if (probe.status !== 200)
                flag('C6', 'FAIL', {
                    text: `GET ${env.HTTP_PUBLIC_URL}/bots → ${probe.status} — something other than the kit answered at HTTP_PUBLIC_URL:`,
                    remedy: 'check it points at the port `efk start` listens on and that no proxy or error page sits in front of it',
                })
            else {
                const bots = (probe.body as { bots?: unknown[] } | undefined)?.bots
                const expectedCount = roster.length > 0 ? roster.length : null
                if (!Array.isArray(bots) || (expectedCount !== null && bots.length < expectedCount)) {
                    flag('C6', 'FAIL', {
                        text: `GET /bots returned ${Array.isArray(bots) ? bots.length : 'no'} bots, the roster has ${expectedCount ?? '?'}: the contract requires every bot on every call. The kit only ever omits a bot that has NEVER had a position —`,
                        remedy: 'check the log for the line naming them',
                    })
                } else
                    flag('C6', 'WARN', {
                        text: `your server answered from this machine with ${bots.length} bots — this does not prove that remi can reach you (NAT, split DNS);`,
                        remedy: 'the real check is remi calling you',
                    })
            }
        } else {
            add('C5', 'SKIP', 'transport variables missing (see C1)')
            add('C6', 'SKIP', 'transport variables missing (see C1)')
        }

        if (deps.demo) {
            // The rule C2's demo FAIL exists to prevent, arriving through the back door: in demo mode
            // `listDeliveries` is answered from memory, so a PASS here would tell a partner their key
            // carries the `delivery` scope when nothing was verified at all. They would find out when
            // a real `efk order` fails — with the one tool meant to catch it having already said yes.
            add('C7', 'SKIP', 'demo mode')
        } else {
            const deliveries = await deps.remi.listDeliveries(1)
            if (deliveries.ok) add('C7', 'PASS', 'the key carries `delivery`: efk order is available')
            else if (deliveries.status === 403)
                flag('C7', 'WARN', {
                    text: 'the key does not carry `delivery`; you can simulate but not create test orders —',
                    remedy: 'ask Robot.com',
                })
            else
                flag('C7', 'WARN', {
                    text: `GET /api/v3/delivery/ → ${deliveries.status} ${deliveries.code} — the delivery probe did not answer, so \`efk order\` may not work;`,
                    remedy: 'retry, and if it persists ask Robot.com about the scopes on your key',
                })
        }
    }

    const parity = await runParity(deps.parity)
    if (parity.ok) add('C8', 'PASS', `frozen samples validate (${parity.detail})`)
    else
        flag('C8', 'FAIL', {
            text: `your copy of src/contract/ is modified or corrupt (${parity.detail});`,
            remedy: 'restore it — this says nothing about the published page',
        })

    /**
     * C9 inspects the REAL drivers: one per bot id in the roster, built exactly as `efk start` builds
     * them, and never started — `driverVersion` and `capabilities()` are pure reads, while `start()`
     * would open connections to a partner's robots from a command documented as read-only. A single
     * probe driver built with a made-up id (the old `EFK-CHECK`) checked a bot that does not exist,
     * so a factory that only misbehaves for a real id — the commonest way a per-bot lookup breaks —
     * passed. There is no "no origin" branch either: the origin comes from SANDBOX_CENTER_*, and a
     * `.env` without them never reaches here (C1 fails and `deps.env` is null).
     */
    if (!deps.config)
        flag('C9', 'FAIL', {
            text: `efk.config.ts did not load: ${deps.configError ?? 'unknown error'} —`,
            remedy: 'check the file is at the root of the directory you ran `efk` from and default-exports defineConfig({ driver, fleet })',
        })
    else if (!deps.env) add('C9', 'SKIP', 'needs a .env that parses')
    else if (roster.length === 0) add('C9', 'SKIP', 'needs the roster (see C3)')
    // Asked before building anything, same as `efk start`. Without it every bot would be reported as
    // "driver factory threw", under a remedy that says `efk start` would fail on the same bot — which
    // stopped being true when an unconfigured driver became an idle start rather than a failure.
    else if (deps.config.driver.unavailable?.())
        add('C9', 'SKIP', `${deps.config.driver.unavailable()}; \`efk start\` would run idle, driving no robot`)
    else {
        // The same origin `efk start` uses. A driver that needs one says so itself, and the `catch`
        // below reports it against the bot — which is exactly what C9 is for.
        const origin = sandboxOrigin(deps.env)
        const c9Fails: Finding[] = []
        const c9Warns: Finding[] = []
        for (const botId of roster) {
            try {
                const driver = deps.config.driver(botId, { origin, fleetSerial: fleetSerials.get(botId) ?? null })
                if (driver.driverVersion !== 1) {
                    c9Fails.push({
                        text: `${botId}: driver implements version ${String(driver.driverVersion)};`,
                        remedy: 'update it to RobotDriver v1',
                    })
                    continue
                }
                if (typeof driver.validateDestination !== 'function') {
                    c9Fails.push({
                        text: `${botId}: driver lacks validateDestination, which v1 requires —`,
                        remedy: 'use defaultValidateDestination from the kit if your robots do not correct destinations',
                    })
                    continue
                }
                const caps = driver.capabilities()
                const missing = (['navigate_to', 'cancel_navigation'] as const).filter((c) => !caps.supportedCommands.includes(c))
                if (missing.length > 0) {
                    c9Fails.push({
                        text: `${botId}: supportedCommands lacks ${missing.join(' and ')}, which remi requires: the bot cannot take a delivery, and remi rejects a capabilities document whose default lacks them (400 CAPABILITIES_MISSING_REQUIRED_COMMANDS) —`,
                        remedy: "add navigate_to and cancel_navigation to the driver's supportedCommands",
                    })
                    continue
                }
                if (caps.hasDoor && !caps.supportedCommands.includes('set_door')) {
                    c9Warns.push({
                        text: `${botId}: declares a door but not set_door — remi will send set_door and you will reject it;`,
                        remedy: "add set_door to the driver's supportedCommands, or report hasDoor: false",
                    })
                }
            } catch (error) {
                c9Fails.push({
                    text: `${botId}: driver factory threw: ${error instanceof Error ? error.message : String(error)} —`,
                    remedy: 'that error comes from the `driver` factory in your efk.config.ts, not from the kit; efk start would fail on the same bot',
                })
            }
        }
        // Scenario overrides keyed on a bot that is not in the roster do nothing at all, which looks
        // exactly like a kit that ignores its own scenarios. The bundled scenarios use the Acme cast.
        const strays = deps.config.driver.auditRoster?.(roster) ?? []
        if (strays.length > 0)
            c9Warns.push({
                text: `scenario overrides name bots that are not in your roster: ${strays.join(', ')} —`,
                remedy: 'edit the ids in the scenario to match yours',
            })

        if (c9Fails.length > 0) flag('C9', 'FAIL', ...c9Fails)
        else if (c9Warns.length > 0) flag('C9', 'WARN', ...c9Warns)
        else
            add(
                'C9',
                'PASS',
                `driver v1 ok for all ${roster.length} bots; fleet.supportsCommandInterrupt = ${deps.config.fleet.supportsCommandInterrupt}`,
            )
    }

    return { rules, exitCode: rules.some((r) => r.status === 'FAIL') ? 1 : 0 }
}

/**
 * The rendered report. `message` is already the composition of a rule's findings (`text remedy`,
 * joined), so this renders it as it stands and no remedy can be dropped on the way out — including
 * by a renderer that is not this one.
 */
export function formatReport(report: CheckReport): string {
    const width = Math.max(...report.rules.map((r) => r.id.length))
    return `${report.rules.map((r) => `${r.status.padEnd(4)} ${r.id.padEnd(width)}  ${r.message}`).join('\n')}\n${report.exitCode === 0 ? 'OK' : 'FAIL'}`
}
