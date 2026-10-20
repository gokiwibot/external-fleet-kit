/**
 * The External Fleets contract, vendored from /docs/external-fleets as zod schemas.
 *
 * Two strictness regimes, on purpose:
 *  - `z.strictObject` for everything the kit EMITS (BotState, BotEvent, the capabilities document,
 *    the partner's HTTP bodies) and for the frozen samples: there an undeclared key is our bug and
 *    the point of vendoring the contract is to notice it.
 *  - `z.looseObject` for everything remi RETURNS (fleet config, the bot mirror, the list envelope,
 *    problem bodies): remi adds fields additively, and a partner's fleet must not stop on a Tuesday
 *    because a new field appeared in a response it does not even read.
 *
 * This split is a DELIBERATE DIVERGENCE from the design document, which asks for `z.strictObject`
 * everywhere. Strictness on a response the kit does not own turns remi's next additive field into an
 * outage on the partner's side; the divergence buys that back and is reviewed as such.
 *
 * Frozen against the page AFTER PR N2 (see the umbrella spec, findings H1, H2, H5, H6):
 *  - `CommandStatus.state` has `rejected`, with `rejected_at`; `accepted_at` is optional only then.
 *  - `corrected_position` / `correction_distance_m` live on `CommandStatus`; the distance is also
 *    valid on a `rejected` whose code is `DESTINATION_UNREACHABLE`.
 *  - `FleetCapabilities` is a named type.
 * Names match `packages/external-fleets/src/contract.ts` of the F1–F4 plan where both exist, so a
 * future move to an npm package is an import change.
 */
import { z } from 'zod'
import { BOT_ID_MAX_LENGTH, BOT_ID_REGEX, NAMESPACE_REGEX } from './ids'

/** zod 4 moved the string formats to their own namespace: `z.iso.datetime`, `z.url`, `z.email`. */
const isoTimestamp = z.iso.datetime({ offset: true })

export const botIdSchema = z.string().min(1).max(BOT_ID_MAX_LENGTH).regex(BOT_ID_REGEX)
export const namespaceSchema = z.string().regex(NAMESPACE_REGEX)

export const botPositionSchema = z.strictObject({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
})
export type BotPosition = z.output<typeof botPositionSchema>

/**
 * `BotState.position` only: a position that may also say where the bot is facing. `azimuth` is a
 * COMPASS bearing, degrees from true North, clockwise (0 = North, 90 = East), nominally [0, 360).
 * Optional; any finite number is accepted, because remi normalises it rather than rejecting the
 * state. A destination (`corrected_position`, `navigate_to`) has no orientation, so those keep the
 * strict two-field `botPositionSchema`. Mirrors the page's `BotPosition`.
 */
export const botStatePositionSchema = botPositionSchema.extend({ azimuth: z.number().optional() })

export const botBatterySchema = z.strictObject({ percentage: z.number().int().min(0).max(100) })

export const doorStateSchema = z.enum(['opened', 'closed', 'opening', 'closing', 'stalled', 'unknown', 'unsupported'])
export type DoorState = z.output<typeof doorStateSchema>

export const commandTypeSchema = z.enum(['navigate_to', 'cancel_navigation', 'set_door'])
export type CommandType = z.output<typeof commandTypeSchema>

/** The four codes a partner may answer a command with, in HTTP (4xx) or in MQTT (`state: rejected`). */
export const REJECTION_CODES = ['UNSUPPORTED_COMMAND', 'COMMAND_EXPIRED', 'BOT_BUSY', 'DESTINATION_UNREACHABLE'] as const
export type RejectionCode = (typeof REJECTION_CODES)[number]

export const commandStatusSchema = z
    .strictObject({
        id: z.string().min(1),
        state: z.enum(['accepted', 'executing', 'succeeded', 'failed', 'rejected']),
        accepted_at: isoTimestamp.optional(),
        rejected_at: isoTimestamp.optional(),
        updated_at: isoTimestamp.optional(),
        error: z.strictObject({ code: z.string().min(1), message: z.string() }).optional(),
        corrected_position: botPositionSchema.optional(),
        correction_distance_m: z.number().min(0).optional(),
    })
    .superRefine((value, ctx) => {
        if (value.state === 'rejected') {
            if (!value.rejected_at) ctx.addIssue({ code: 'custom', path: ['rejected_at'], message: 'required when state is rejected' })
            if (!value.error) ctx.addIssue({ code: 'custom', path: ['error'], message: 'required when state is rejected' })
            else if (!(REJECTION_CODES as readonly string[]).includes(value.error.code)) {
                ctx.addIssue({ code: 'custom', path: ['error', 'code'], message: `must be one of ${REJECTION_CODES.join(', ')}` })
            }
            if (value.corrected_position) ctx.addIssue({ code: 'custom', path: ['corrected_position'], message: 'never on a rejection' })
            if (value.correction_distance_m !== undefined && value.error?.code !== 'DESTINATION_UNREACHABLE') {
                ctx.addIssue({
                    code: 'custom',
                    path: ['correction_distance_m'],
                    message: 'on a rejection, only with DESTINATION_UNREACHABLE',
                })
            }
            return
        }
        if (!value.accepted_at) ctx.addIssue({ code: 'custom', path: ['accepted_at'], message: 'required unless state is rejected' })
        if (value.rejected_at) ctx.addIssue({ code: 'custom', path: ['rejected_at'], message: 'only when state is rejected' })
        if (value.state === 'failed' && !value.error)
            ctx.addIssue({ code: 'custom', path: ['error'], message: 'required when state is failed' })
        // The page scopes the correction to a command that is still going somewhere: "Present while
        // `state` is `accepted` or `executing`". On a terminal it would describe a destination the bot
        // already left, which is exactly the kind of stale field that makes remi's audit trail lie.
        const inFlight = value.state === 'accepted' || value.state === 'executing'
        if (!inFlight && value.corrected_position) {
            ctx.addIssue({ code: 'custom', path: ['corrected_position'], message: 'only while state is accepted or executing' })
        }
        if (!inFlight && value.correction_distance_m !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['correction_distance_m'], message: 'only while state is accepted or executing' })
        }
        // Outside a DESTINATION_UNREACHABLE rejection the distance measures the gap to
        // `corrected_position`; without that field it measures nothing.
        if (inFlight && value.correction_distance_m !== undefined && !value.corrected_position) {
            ctx.addIssue({
                code: 'custom',
                path: ['correction_distance_m'],
                message: 'needs corrected_position unless it is a DESTINATION_UNREACHABLE rejection',
            })
        }
    })
export type CommandStatus = z.output<typeof commandStatusSchema>

/** The 202 body of `POST /bots/:bot_id/commands` is a CommandStatus (H2 folded the correction into it). */
export const commandAcceptedSchema = commandStatusSchema

export const botStateSchema = z.strictObject({
    bot_id: botIdSchema,
    seq: z.number().int().min(0).optional(),
    timestamp: isoTimestamp,
    available: z.boolean(),
    /**
     * Optional: the fleet has taken this robot out of service. Absent = not reported = `false` for remi.
     * On `true` remi parks the bot `off_duty` (operator status) unless it is on a job or an operator
     * already set another status; it is one-way — remi never un-parks it when this goes back to `false`,
     * a remi operator does. Mirrors the page's `BotState.out_of_service`.
     */
    out_of_service: z.boolean().optional(),
    connected: z.boolean(),
    position: botStatePositionSchema,
    battery: botBatterySchema,
    motion: z.strictObject({ speed_mps: z.number().min(0) }).optional(),
    door: doorStateSchema,
    current_command: commandStatusSchema.nullable(),
})
export type BotState = z.output<typeof botStateSchema>

/**
 * The command envelope with `type` as a bare non-empty string instead of `commandTypeSchema`. It
 * exists ONLY so the HTTP and MQTT transports can tell two different failures apart before they
 * answer: a body that is well-formed except for an unrecognised `type` (contract `data.ts:216` —
 * 422 `UNSUPPORTED_COMMAND`) versus a body that is malformed on its own terms — a missing field, a
 * bad timestamp, wrong params for the type it does name (400 `INVALID_BODY`). Parse against this
 * FIRST: if it succeeds but `commandTypeSchema.safeParse(type)` fails, the type is the one and only
 * problem. If this also fails, the body was never going to validate regardless of `type`.
 */
export const botCommandEnvelopeSchema = z.strictObject({
    id: z.string().min(1),
    type: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    issued_at: isoTimestamp,
    expires_at: isoTimestamp.optional(),
})

export const botCommandSchema = z
    .strictObject({
        id: z.string().min(1),
        type: commandTypeSchema,
        params: z.record(z.string(), z.unknown()).optional(),
        issued_at: isoTimestamp,
        expires_at: isoTimestamp.optional(),
    })
    .superRefine((value, ctx) => {
        const params = value.params ?? {}
        if (value.type === 'navigate_to' && !botPositionSchema.safeParse(params).success) {
            ctx.addIssue({ code: 'custom', path: ['params'], message: 'navigate_to needs { lat, lng }' })
        }
        if (value.type === 'set_door' && !z.strictObject({ state: z.enum(['open', 'closed']) }).safeParse(params).success) {
            ctx.addIssue({ code: 'custom', path: ['params'], message: 'set_door needs { state: open | closed }' })
        }
    })
export type BotCommand = z.output<typeof botCommandSchema>

export const botEventSchema = z
    .strictObject({
        bot_id: botIdSchema,
        type: z.enum(['arrived', 'blocked', 'unblocked']),
        command_id: z.string().min(1).optional(),
        occurred_at: isoTimestamp,
        detail: z.strictObject({ reason: z.string(), message: z.string() }).optional(),
    })
    .superRefine((value, ctx) => {
        if (value.type === 'arrived' && !value.command_id)
            ctx.addIssue({ code: 'custom', path: ['command_id'], message: 'required for arrived' })
    })
export type BotEvent = z.output<typeof botEventSchema>

export const botCapabilitiesSchema = z.strictObject({
    has_door: z.boolean(),
    supported_commands: z.array(commandTypeSchema),
})
export type BotCapabilities = z.output<typeof botCapabilitiesSchema>

export const fleetCapabilitiesSchema = z.strictObject({
    supports_command_interrupt: z.boolean(),
    default: botCapabilitiesSchema,
    overrides: z.record(botIdSchema, botCapabilitiesSchema.partial()).optional(),
})
export type FleetCapabilities = z.output<typeof fleetCapabilitiesSchema>

export const destinationValidationSchema = z.union([
    z.strictObject({ reachable: z.literal(true), corrected_position: botPositionSchema, correction_distance_m: z.number().min(0) }),
    z.strictObject({
        reachable: z.literal(false),
        reason: z.enum(['out_of_service_area', 'no_route', 'unsupported_area']),
        correction_distance_m: z.number().min(0).optional(),
    }),
])
export type DestinationValidation = z.output<typeof destinationValidationSchema>

/**
 * What `GET /api/v3/fleet` returns. LOOSE: remi owns this shape and will add to it.
 * `max_bots` has no upper bound here — 200 is today's ceiling, not a law of the contract, and a
 * partner whose fleet grew must not be stopped by the kit's copy of an old number. `efk check` C2
 * WARNs above 200 instead (Task 15).
 */
export const fleetConfigResponseSchema = z.looseObject({
    namespace: namespaceSchema,
    bot_id_prefix: z.string().min(1),
    /**
     * Whether this fleet's bot ids are INTERNAL ids rather than the fleet's own serials, so every
     * bot must carry `fleet_serial`. Optional for an older remi that does not send it; absent is
     * read as false, which is the original prefix-stripping behaviour.
     *
     * When true the prefix fallback is never right — `ACME-0173` with prefix `ACME-` strips to `0173`,
     * a plausible serial that may not exist — so the manager parks the fleet instead of driving a
     * robot chosen by accident.
     */
    requires_fleet_serial: z.boolean().optional(),
    transport: z.enum(['mqtt', 'http']),
    base_url: z.url().nullable(),
    token_set: z.boolean(),
    poll_interval_active_ms: z.number().int(),
    poll_interval_idle_ms: z.number().int(),
    max_bots: z.number().int().min(1),
    contract_version: z.string(),
})
export type FleetConfigResponse = z.output<typeof fleetConfigResponseSchema>

export const fleetBotResponseSchema = z.strictObject({
    bot_id: botIdSchema,
    namespace: namespaceSchema,
    location_id: z.string().nullable(),
    manual_close_door: z.boolean(),
    commercial_name: z.string(),
    tags: z.array(z.string()),
    retired_at: isoTimestamp.nullable(),
})

export const BLOCKED_BY = [
    'disconnected',
    'unavailable',
    'battery_below_minimum',
    'no_position',
    'no_location',
    'state_stale',
    'retired',
] as const
export type BlockedBy = (typeof BLOCKED_BY)[number]

/**
 * One element of `GET /api/v3/fleet/bots`: what remi believes about a bot. LOOSE, like every remi
 * response — and `blocked_by` is `z.string()`, not the enum: a reason remi adds tomorrow must show up
 * in `efk check` C4 as an unexplained reason, not blow up the parse of the whole roster. `BLOCKED_BY`
 * stays exported as the list the kit knows how to explain.
 */
export const fleetBotMirrorSchema = z.looseObject({
    bot_id: botIdSchema,
    /**
     * The id this bot has in the FLEET's own system, when remi holds one. Optional so an older remi
     * that does not send the field still parses; null means "derive it from `bot_id`", the original
     * rule where the serial is the id minus the fleet prefix. No grammar: this string is the
     * fleet's, not ours — it never becomes an MQTT topic level.
     */
    fleet_serial: z.string().nullable().optional(),
    location_id: z.string().nullable(),
    assignable: z.boolean(),
    blocked_by: z.array(z.string()),
    state_age_ms: z.number().int().min(0).nullable(),
    current_job_id: z.string().nullable(),
})
export type FleetBotMirror = z.output<typeof fleetBotMirrorSchema>

export const fleetBotListResponseSchema = z.looseObject({
    data: z.array(fleetBotMirrorSchema),
    next_cursor: z.string().nullable(),
})

/**
 * RFC 7807 body remi and the partner exchange on errors (`page.tsx:678-705`).
 *
 * THE MACHINE CODE IS `code`, NOT `title`. The page is explicit: "remi returns errors in the
 * application/problem+json format (RFC 7807) with a stable machine-readable `code`. Branch on `code`,
 * never on `detail`" — and its own sample is `{ "title": "Bad Request", …, "code":
 * "BOT_ID_NOT_NAMESPACED" }`. `title` is the human phrase for the status. Loose because the contract
 * itself hangs extensions off the body (`correction_distance_m` on the 422).
 */
export const problemDetailsSchema = z.looseObject({
    type: z.string(),
    title: z.string().min(1),
    status: z.number().int(),
    code: z.string().min(1),
    detail: z.string().optional(),
    instance: z.string().optional(),
})
export type ProblemDetails = z.output<typeof problemDetailsSchema>

/** `{ data: … }` envelope of the remi v3 API. Loose: `data` is what we read, the rest is remi's. */
export const envelope = <T extends z.ZodType>(inner: T) => z.looseObject({ data: inner })
