/**
 * What this checks, and nothing more:
 *  1. every frozen sample in samples/ validates against its schema;
 *  2. every sample file has an expectation (a file nobody claims is a file nobody checks);
 *  3. SOURCE.json exists and names every extracted sample.
 * What it does NOT check: that the published page has not changed. It cannot — the samples live
 * here. That drift is detected in kiwi-platforms (KIT_SYNC.json + CI job), which is what triggers
 * `pnpm sync-samples` and a new kit version.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
    botBatterySchema,
    botCapabilitiesSchema,
    botCommandSchema,
    botEventSchema,
    botIdSchema,
    botPositionSchema,
    botStateSchema,
    commandStatusSchema,
    destinationValidationSchema,
    envelope,
    fleetBotListResponseSchema,
    fleetBotResponseSchema,
    fleetCapabilitiesSchema,
    fleetConfigResponseSchema,
    problemDetailsSchema,
} from './schemas'
import { CONTRACT_VERSION } from './version'

export const SAMPLES_DIR = join(import.meta.dirname, 'samples')
export const readSample = (name: string) => JSON.parse(readFileSync(join(SAMPLES_DIR, `${name}.json`), 'utf8')) as unknown

// Shapes that only exist as remi-side request/response bodies (no exported schema needed elsewhere).
// `bot_id` uses `botIdSchema`, not a bare string: these samples are exactly where a malformed id
// would have to be caught, and the kit already owns the grammar.
const partnerListBotsResponse = z.strictObject({ bots: z.array(botStateSchema) })
const fleetUpdateConfigRequest = z.strictObject({
    transport: z.enum(['mqtt', 'http']).optional(),
    base_url: z.url().optional(),
    token: z.string().min(32).optional(),
})
const fleetRegisterBotRequest = z.strictObject({
    bot_id: botIdSchema,
    manual_close_door: z.boolean().optional(),
    commercial_name: z.string().optional(),
    tags: z.array(z.string()).optional(),
})
const fleetUpdateBotRequest = z.strictObject({
    manual_close_door: z.boolean().optional(),
    commercial_name: z.string().optional(),
    tags: z.array(z.string()).optional(),
})
const fleetRetireResponse = z.strictObject({ bot_id: botIdSchema, retired_at: z.iso.datetime({ offset: true }) })
const pushStateResponse = z.strictObject({ accepted: z.number().int(), rejected: z.number().int() })
const reportEventResponse = z.strictObject({ accepted: z.literal(true) })

/** Which schema each sample (by file name, without .json) must satisfy. Unlisted files fail. */
export const expectations: Record<string, z.ZodType> = {
    'partner-create-command__request-navigate-to': botCommandSchema,
    'partner-create-command__request-set-door-open': botCommandSchema,
    'partner-create-command__request-cancel-navigation': botCommandSchema,
    'partner-create-command__response-202': commandStatusSchema,
    'partner-validate-destination__request': botPositionSchema,
    'partner-validate-destination__response-200-reachable': destinationValidationSchema,
    'partner-validate-destination__response-200-not-reachable': destinationValidationSchema,
    'fleet-update-config__request': fleetUpdateConfigRequest,
    'fleet-register-bot__request': fleetRegisterBotRequest,
    'fleet-register-bot__response-201': envelope(fleetBotResponseSchema),
    'fleet-update-bot__request': fleetUpdateBotRequest,
    'fleet-retire-bot__response-200': envelope(fleetRetireResponse),
    'fleet-list-bots__response-200': fleetBotListResponseSchema,
    'fleet-push-state__response-202': envelope(pushStateResponse),
    'fleet-report-event__request-arrived': botEventSchema,
    'fleet-report-event__request-blocked': botEventSchema,
    'fleet-report-event__response-202': envelope(reportEventResponse),
    'type-bot-state__botstate': botStateSchema,
    'type-bot-position__botposition': botPositionSchema,
    'type-bot-battery__botbattery': botBatterySchema,
    'type-bot-command__botcommand-navigate-to': botCommandSchema,
    'type-command-status__commandstatus': commandStatusSchema,
    'type-bot-capabilities__botcapabilities': botCapabilitiesSchema,
    'type-bot-event__botevent-arrived': botEventSchema,
    'type-fleet-config__fleetconfig-response': fleetConfigResponseSchema,
    'type-fleet-bot__fleetbot': fleetRegisterBotRequest,
    'type-fleet-bot-response__fleetbot-response': fleetBotResponseSchema,
    // Hand-written while N2 is unmerged. The first three carry the name sync-samples will give them
    // once the page ships them, so re-extraction after the merge produces the same bytes: drop the
    // `handmade__` prefix from these rows then, and delete the hand-written files. The published
    // `partner-list-bots` 200 is here too because N2 rewrites it — its two `current_command` objects
    // ship with no `accepted_at`, which the published `CommandStatus` already declares required — so
    // the frozen copy comes from the corrected text, not from the page as published, and calling it
    // `extracted` in SOURCE.json would misdescribe where it came from.
    // The last one has no page origin at all — the page publishes no 422 problem body — so it stays
    // hand-written for ever.
    'handmade__partner-list-bots__response-200': partnerListBotsResponse,
    'handmade__partner-create-command__botstate-current-command-rejected-mqtt-mode': commandStatusSchema,
    'handmade__type-fleet-capabilities__fleetcapabilities': fleetCapabilitiesSchema,
    'handmade__problem-details__422-destination-unreachable': problemDetailsSchema,
}

export function sampleNames(): string[] {
    return readdirSync(SAMPLES_DIR)
        .filter((f) => f.endsWith('.json') && f !== 'SOURCE.json')
        .map((f) => f.replace(/\.json$/, ''))
}

/**
 * Reads a sample without throwing. `readSample` above stays as it is — a missing file SHOULD blow up
 * the per-sample test next to it — but the whole-check runner must never throw: its caller is
 * `efk check` C8, the first command a partner runs, and a mis-synced clone (a sample deleted, the
 * directory half-copied) is exactly the case C8 exists to diagnose. A stack trace there ends the
 * investigation; a failed result with the remedy continues it.
 */
function tryReadSample(name: string): { ok: true; value: unknown } | { ok: false; error: string } {
    try {
        return { ok: true, value: readSample(name) }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
}

/** The whole parity check as one call, so the test and `efk check` C8 cannot drift apart. It reports; it never throws. */
export async function runParityInProcess(): Promise<{ ok: boolean; detail: string }> {
    const problems: string[] = []
    let files: string[]
    try {
        files = sampleNames()
    } catch (error) {
        // No samples directory at all: nothing below can say anything useful, so stop here.
        return { ok: false, detail: `the samples directory is unreadable: ${error instanceof Error ? error.message : String(error)}` }
    }

    for (const file of files) {
        if (!(file in expectations)) problems.push(`${file}: no expectation declared`)
    }
    for (const [name, schema] of Object.entries(expectations)) {
        const raw = tryReadSample(name)
        if (!raw.ok) {
            problems.push(`${name}: the expectation names a sample that is not readable (${raw.error})`)
            continue
        }
        const result = schema.safeParse(raw.value)
        if (!result.success) problems.push(`${name}: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
    }

    const rawSource = tryReadSample('SOURCE')
    const source = rawSource.ok ? (rawSource.value as { commit?: unknown; sha256?: unknown; files?: unknown }) : null
    if (!source) problems.push(`SOURCE.json is missing or unreadable (${rawSource.ok ? '' : rawSource.error})`)
    else {
        if (!source.commit) problems.push('SOURCE.json has no commit')
        if (!source.sha256) problems.push('SOURCE.json has no sha256')
        const extracted = files.filter((f) => !f.startsWith('handmade__')).sort()
        // `files` used to be spread unguarded, so a SOURCE.json without it threw a TypeError instead
        // of reporting the very thing this line is here to check.
        if (!Array.isArray(source.files)) problems.push('SOURCE.json has no files list')
        else if (JSON.stringify(extracted) !== JSON.stringify([...(source.files as string[])].sort())) {
            problems.push('SOURCE.json.files does not match the extracted samples on disk')
        }
    }

    const rawConfig = tryReadSample('type-fleet-config__fleetconfig-response')
    const config = rawConfig.ok ? fleetConfigResponseSchema.safeParse(rawConfig.value) : null
    if (!config) problems.push('the frozen FleetConfig sample is not readable')
    else if (!config.success) problems.push('the frozen FleetConfig sample does not parse')
    else if (config.data.contract_version !== CONTRACT_VERSION) {
        problems.push(`the frozen FleetConfig sample says contract ${config.data.contract_version}, version.ts says ${CONTRACT_VERSION}`)
    }

    return problems.length === 0
        ? { ok: true, detail: `${files.length} samples, contract ${CONTRACT_VERSION}, data.ts ${String(source?.commit)}` }
        : { ok: false, detail: problems.join(' | ') }
}
