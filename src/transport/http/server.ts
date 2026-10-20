/**
 * The remaining endpoints of "Endpoints you implement" (design §9.5) — `/capabilities` is gone; remi
 * now stores the document instead of polling for it (`RemiClient.setCapabilities`). Bearer
 * HTTP_TOKEN; 202 and never 200 on a command; 4xx with the contract codes; 503 DRIVER_ERROR when the
 * driver threw. That 503 does NOT make remi retry — the contract declares no 5xx policy, and saying
 * otherwise in a public repo would be teaching the partner something false. It leaves the command
 * unanswered, and the re-send arrives through the resend policy remi already has (the same id, up to
 * three sends, `data.ts:211`). `POST /destinations/validate` is answered by the first bot's driver:
 * it is a fleet question and must give the same answer for the same coordinate.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import {
    type BotCommand,
    botCommandEnvelopeSchema,
    botCommandSchema,
    botPositionSchema,
    type CommandStatus,
    commandTypeSchema,
    type RejectionCode,
} from '../../contract/schemas'
import type { BotRuntime } from '../../core/bot-runtime'
import type { LedgerEntry } from '../../core/command-ledger'
import type { CommandOutcome, EventBus } from '../../core/events'
import type { ServedState } from '../../core/fleet-manager'
import { problem } from './problem'

export type PartnerAppDeps = {
    token: string
    bots: () => BotRuntime[]
    /**
     * THE POLL PATH, and the only way `GET /bots` may build its answer: `FleetManager.serve()`. It
     * assembles every bot, falls back to the last valid state, ACKNOWLEDGES what it served — which is
     * what drains the ledger's queue of unpublished outcomes in polling mode, where nothing is ever
     * pushed — and emits `state.served` itself. Assembling the list here from `bots()` instead would
     * answer the poll and leave every command outcome stranded behind the oldest one, so remi would
     * never learn how a command ended and its job steps would hang until they timed out.
     */
    serve: () => ServedState[]
    /** Where a command goes. The transport wires this to whatever the FleetManager registered. */
    onCommand: (botId: string, command: BotCommand) => Promise<CommandOutcome>
    bus: EventBus
}

/**
 * The one and only mapping from a rejection code to an HTTP status. The TUI imports THIS (Task 17)
 * instead of keeping its own copy: two tables mean the dashboard can say 409 while the wire carried
 * a 422, and the partner would be debugging the wrong thing.
 */
export const REJECTION_STATUS: Record<RejectionCode, number> = {
    COMMAND_EXPIRED: 409,
    BOT_BUSY: 409,
    UNSUPPORTED_COMMAND: 422,
    DESTINATION_UNREACHABLE: 422,
}

/**
 * What a command displaced by a newer navigation is called ON THE WIRE. `REPLACED` is the ledger's
 * INTERNAL marker (`CommandLedger.replace`) and must never leave this process: the contract has no
 * such outcome, and nothing underneath would stop it — `commandStatusSchema` constrains `error.code`
 * only on a `rejected`, so a `failed` carrying `REPLACED` validates cleanly and goes out. Like
 * `CANCELLED`, this is a kit error code on a `failed`, which the contract leaves free-form.
 */
export const SUPERSEDED_ERROR = { code: 'SUPERSEDED', message: 'superseded by a newer navigate_to' } as const

/**
 * The only rendering of a ledger entry this module hands to a caller. It BRANCHES ON `internalCode`
 * — not on the error string — because `ledgerEntry()` exposes the replaced entry on purpose: the id
 * is known, so `GET /bots/:bot_id/commands/*` owes it a 200 rather than a 404 that would read as
 * "never received" and invite a resend.
 */
function publicStatus(entry: LedgerEntry): CommandStatus {
    if (entry.internalCode !== 'REPLACED') return entry.status
    return { ...entry.status, error: { ...SUPERSEDED_ERROR } }
}

const accepted202 = (body: unknown) => new Response(JSON.stringify(body), { status: 202, headers: { 'content-type': 'application/json' } })

/**
 * A RESEND of a command id must get the SAME answer as the first time — that is what idempotency
 * means on the wire. Answering 202 to every duplicate is the trap: a command this fleet REJECTED has
 * a recorded status of `rejected`, and a 202 carrying it tells remi "accepted, I am working on it"
 * about work that will never happen. remi (3 sends, `data.ts:211`) resends exactly in the cases where
 * this matters, so the second answer is the one it usually acts on. A duplicate therefore replays the
 * original response: the 4xx problem body for a rejection, the 202 for an acceptance.
 */
export function outcomeToResponse(outcome: CommandOutcome): Response {
    switch (outcome.kind) {
        case 'accepted':
            return accepted202(outcome.status)
        case 'duplicate': {
            const { status } = outcome
            if (status.state !== 'rejected') return accepted202(status)
            const code = (status.error?.code ?? 'UNSUPPORTED_COMMAND') as RejectionCode
            return problem(REJECTION_STATUS[code] ?? 422, code, {
                detail: status.error?.message ?? 'previously rejected',
                ...(code === 'DESTINATION_UNREACHABLE' && status.correction_distance_m !== undefined
                    ? { correction_distance_m: status.correction_distance_m }
                    : {}),
            })
        }
        case 'rejected':
            return problem(REJECTION_STATUS[outcome.code] ?? 422, outcome.code, {
                detail: outcome.message,
                ...(outcome.code === 'DESTINATION_UNREACHABLE' && outcome.correctionDistanceM !== undefined
                    ? { correction_distance_m: outcome.correctionDistanceM }
                    : {}),
            })
        case 'driver_error':
            return problem(503, 'DRIVER_ERROR', { detail: outcome.message })
    }
}

/**
 * CONSTANT TIME, over digests. This header is the only thing between the public internet and a
 * partner's fleet, and `===` on strings returns at the first differing byte — enough for a caller
 * who can measure to walk the token one character at a time. Both sides are hashed first so the
 * comparison is always over 32 bytes: `timingSafeEqual` throws on a length mismatch, and guarding
 * that with a length check would leak the token's length instead.
 */
function bearerCheck(token: string): (header: string) => boolean {
    const expected = createHash('sha256').update(`Bearer ${token}`).digest()
    return (header) => timingSafeEqual(createHash('sha256').update(header).digest(), expected)
}

export function createPartnerApp(deps: PartnerAppDeps): Hono {
    const app = new Hono()
    const authorised = bearerCheck(deps.token)

    /**
     * BEFORE the bearer middleware, and that order is the whole point: hono runs middleware in
     * registration order, and a load balancer's health check usually sends no headers at all, so a
     * /healthz behind the guard would answer 401 and the container would never become ready. It says
     * nothing about the fleet — liveness of this process only.
     */
    app.get('/healthz', (c) => c.json({ ok: true }))

    app.use('*', async (c, next) => {
        // One answer for "no token" and for "wrong token": telling them apart tells a caller probing
        // the surface which half of the guess was right. The token itself is never echoed anywhere.
        if (!authorised(c.req.header('authorization') ?? '')) return problem(401, 'UNAUTHORIZED')
        await next()
    })

    /**
     * "Send every bot on every call" is the contract, and `serve()` is what keeps it: the freshly
     * assembled state, otherwise the last one that did assemble with its own older timestamp so remi
     * can see the staleness and decide. Only a bot that has NEVER had a position is absent from its
     * answer — there is genuinely nothing to say about it — and then it is COUNTED and named in the
     * log here, which is what `efk check` C6 points the partner at. `state.served` is emitted by
     * `serve()` itself; emitting it again here would double every entry in the TUI and the SSE stream.
     */
    app.get('/bots', (c) => {
        const served = deps.serve()
        const delivered = new Set(served.map((entry) => entry.botId))
        const omitted = deps
            .bots()
            .map((runtime) => runtime.botId)
            .filter((botId) => !delivered.has(botId))
        if (omitted.length > 0) {
            deps.bus.emit('log', {
                level: 'warn',
                message: `GET /bots omitted ${omitted.length} bot(s) that have never had a position: ${omitted.join(', ')} — remi cannot dispatch a bot it has no position for`,
            })
        }
        return c.json({ bots: served.map((entry) => entry.state) })
    })

    app.post('/bots/:bot_id/commands', async (c) => {
        const botId = c.req.param('bot_id')
        const runtime = deps.bots().find((r) => r.botId === botId)
        if (!runtime) return problem(404, 'BOT_NOT_FOUND')
        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            return problem(400, 'INVALID_BODY', { detail: 'body is not JSON' })
        }
        const parsed = botCommandSchema.safeParse(body)
        if (!parsed.success) {
            // An unrecognised `type` is NOT a malformed body — contract `data.ts:216` reserves 400 for
            // that and asks for 422 UNSUPPORTED_COMMAND here. Tell the two apart by re-parsing against
            // the envelope with `type` loosened to a bare string: if the envelope is otherwise sound
            // and only `type` fails the enum, the type is the one and only problem. If the envelope
            // itself does not parse, the body was never going to validate regardless of `type`.
            const envelope = botCommandEnvelopeSchema.safeParse(body)
            if (envelope.success && !commandTypeSchema.safeParse(envelope.data.type).success) {
                return problem(422, 'UNSUPPORTED_COMMAND', { detail: `unsupported command type "${envelope.data.type}"` })
            }
            return problem(400, 'INVALID_BODY', { detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
        }
        const outcome = await deps.onCommand(botId, parsed.data)
        // A resend of a navigation a newer one displaced comes back as a `duplicate` carrying the
        // ledger's own status — `REPLACED` and all. Rendered through the entry, so the branch is on
        // `internalCode` and not on a string that happens to match.
        if (outcome.kind === 'duplicate') {
            const entry = runtime.ledgerEntry(parsed.data.id)
            if (entry) return outcomeToResponse({ kind: 'duplicate', status: publicStatus(entry) })
        }
        return outcomeToResponse(outcome)
    })

    /**
     * WILDCARD, not `:command_id`. Command ids are `<job id>/<step>` (`GW-5867/pickup`, straight from
     * the page's own samples), so they contain a slash and a single path parameter would only ever
     * match the first half. The rest of the path is read from `new URL(c.req.url).pathname`, which is
     * the RAW path — nothing has decoded it yet — so the `decodeURIComponent` below is the FIRST and
     * ONLY decode of it, and it is what makes both forms remi may send reach the same command:
     * `GW-5867/pickup` passes through untouched and `GW-5867%2Fpickup` becomes it. Decoding a second
     * time is what must not happen: it would turn a literal `%2F` inside an id into a separator.
     */
    app.get('/bots/:bot_id/commands/*', (c) => {
        const runtime = deps.bots().find((r) => r.botId === c.req.param('bot_id'))
        if (!runtime) return problem(404, 'BOT_NOT_FOUND')
        const prefix = `/bots/${c.req.param('bot_id')}/commands/`
        const path = new URL(c.req.url).pathname
        const commandId = decodeURIComponent(path.slice(path.indexOf(prefix) + prefix.length))
        if (!commandId) return problem(404, 'COMMAND_NOT_FOUND')
        const entry = runtime.ledgerEntry(commandId)
        if (!entry) return problem(404, 'COMMAND_NOT_FOUND')
        return c.json(publicStatus(entry))
    })

    /**
     * A fleet-wide question, answered by the first bot's driver: the contract requires the same
     * coordinate to give the same answer, so it cannot depend on which bot is asked.
     */
    app.post('/destinations/validate', async (c) => {
        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            return problem(400, 'INVALID_COORDINATE')
        }
        const parsed = botPositionSchema.safeParse(body)
        if (!parsed.success) return problem(400, 'INVALID_COORDINATE')
        const first = deps.bots()[0]
        if (!first) return c.json({ reachable: true as const, corrected_position: parsed.data, correction_distance_m: 0 })
        return c.json(await first.validateDestination(parsed.data))
    })

    return app
}
