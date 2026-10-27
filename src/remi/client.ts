/**
 * The only remi surface the kit touches: fleet config, the bot mirror, deliveries
 * for `efk order`, the two push endpoints, and the capabilities document. Never PATCH /fleet, never
 * the roster endpoints. `fetch` is injected so every test runs without a network.
 */
import { z } from 'zod'
import {
    type BotEvent,
    type BotState,
    envelope,
    type FleetBotMirror,
    type FleetCapabilities,
    type FleetConfigResponse,
    fleetBotListResponseSchema,
    fleetCapabilitiesSchema,
    fleetConfigResponseSchema,
    problemDetailsSchema,
} from '../contract/schemas'
import { describeFetchFailure, safeOrigin } from '../net-failure'

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string }

export const deliverySchema = z.looseObject({
    id: z.string(),
    state: z.string(),
    bot: z.looseObject({ id: z.string() }).nullable(),
    arriving: z.boolean().nullable(),
    pickup: z.unknown(),
    dropoff: z.unknown(),
})
export type Delivery = z.output<typeof deliverySchema>

/**
 * The body of `POST /api/v3/delivery`, taken from the Delivery API page
 * (`apps/remi-pro/app/(docs)/docs/delivery-api/data.ts`, spec `create-delivery` plus the `Point`,
 * `Package` and `Item` types). Only the fields the kit actually sends are typed:
 *  - `pickup`/`dropoff` are the REFERENCE form of `Point`: exactly one of `id`, `external_id` or the
 *    `lat`+`lng` pair. The kit always references the sandbox points it was given by external id.
 *  - `location_id` is "conditionally REQUIRED: the only way to resolve raw coordinate points". Two
 *    referenced points already carry their location, so it is optional here — the kit sends
 *    `SANDBOX_LOCATION_ID` anyway, because being explicit costs nothing and a partner reading the
 *    request in a log can see which sandbox it hit.
 *  - `Package` has no required field of its own; `Item` requires `name` and `quantity`.
 *  - `tags`: the page says send `["test"]` to keep trial deliveries out of production metrics.
 */
export type DeliveryPointRef = { external_id: string } | { id: string }
export type CreateDeliveryBody = {
    name: string
    pickup: DeliveryPointRef
    dropoff: DeliveryPointRef
    packages: Array<{ reference: string; items?: Array<{ name: string; quantity: number }> }>
    tags: string[]
    location_id?: string
    external_id?: string
}

export interface RemiClient {
    getFleetConfig(): Promise<Result<FleetConfigResponse>>
    listFleetBots(): Promise<Result<FleetBotMirror[]>>
    listDeliveries(limit: number): Promise<Result<unknown>>
    createDelivery(body: CreateDeliveryBody): Promise<Result<Delivery>>
    getDelivery(id: string): Promise<Result<Delivery>>
    pushState(states: BotState[]): Promise<Result<{ accepted: number; rejected: number }>>
    reportEvent(event: BotEvent): Promise<Result<{ accepted: true }>>
    setCapabilities(caps: FleetCapabilities): Promise<Result<FleetCapabilities>>
}

/** remi's own cap on `POST /api/v3/fleet/state`: at most this many states per HTTP request. */
const MAX_STATES_PER_PUSH = 200

export function createRemiClient(deps: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): RemiClient {
    const fetchFn = deps.fetch ?? fetch
    const base = deps.baseUrl.replace(/\/$/, '')

    async function call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<Result<T>> {
        let response: Response
        try {
            response = await fetchFn(`${base}${path}`, {
                method,
                headers: { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            })
        } catch (error) {
            /**
             * CONSTRUCTED, NEVER FORWARDED (see `net-failure.ts`). `fetch` builds
             * its message out of the request it was given: a `REMI_API_URL` of the form
             * `https://user:password@host` makes it throw with the WHOLE URL, password included, in
             * the text. This result's `message` is printed by `efk check` C2 and by `efk start`, so
             * forwarding it would put that password on screen and into a support email. The origin is
             * named because it is the thing to check, and `URL.origin` is exactly the part of the URL
             * that carries no credentials.
             */
            return {
                ok: false,
                status: 0,
                code: 'NETWORK',
                message: `${describeFetchFailure(error)}; reaching ${safeOrigin(base)}`,
            }
        }
        const text = await response.text()
        let parsedBody: unknown = null
        try {
            parsedBody = text ? JSON.parse(text) : null
        } catch {
            return { ok: false, status: response.status, code: 'NOT_JSON', message: text.slice(0, 200) }
        }
        if (!response.ok) {
            // RFC 7807 as the page defines it: branch on `code`. `title` is the human phrase for the
            // status ("Not Found"), and branching on it would break the day someone rewords it.
            const problem = problemDetailsSchema.safeParse(parsedBody)
            return {
                ok: false,
                status: response.status,
                code: problem.success ? problem.data.code : `HTTP_${response.status}`,
                message: problem.success ? (problem.data.detail ?? problem.data.title) : text.slice(0, 200),
            }
        }
        const data = schema.safeParse(parsedBody)
        if (!data.success) {
            return {
                ok: false,
                status: response.status,
                code: 'CONTRACT_MISMATCH',
                message: data.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
            }
        }
        return { ok: true, data: data.data }
    }

    return {
        async getFleetConfig() {
            const result = await call('GET', '/api/v3/fleet', envelope(fleetConfigResponseSchema))
            return result.ok ? { ok: true, data: result.data.data } : result
        },
        async listFleetBots(): Promise<Result<FleetBotMirror[]>> {
            const all: FleetBotMirror[] = []
            let cursor: string | null = null
            for (;;) {
                const query: string = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : '?limit=200'
                const page = await call('GET', `/api/v3/fleet/bots${query}`, fleetBotListResponseSchema)
                if (!page.ok) return page
                all.push(...page.data.data)
                const nextCursor = page.data.next_cursor
                // Guard against a cursor that comes back unchanged: that is remi (or a proxy in
                // front of it) never advancing, and without this the kit would re-request the same
                // page forever, unattended, accumulating bots in memory with no diagnostic.
                if (nextCursor !== null && nextCursor === cursor) {
                    return {
                        ok: false,
                        status: 0,
                        code: 'STALLED_CURSOR',
                        message: `next_cursor did not advance past '${nextCursor}'; stopping instead of looping forever`,
                    }
                }
                cursor = nextCursor
                if (!cursor) break
            }
            return { ok: true, data: all }
        },
        listDeliveries: (limit) => call('GET', `/api/v3/delivery?limit=${limit}`, z.unknown()),
        async createDelivery(body) {
            const result = await call('POST', '/api/v3/delivery', envelope(deliverySchema), body)
            return result.ok ? { ok: true, data: result.data.data } : result
        },
        async getDelivery(id) {
            const result = await call('GET', `/api/v3/delivery/${encodeURIComponent(id)}`, envelope(deliverySchema))
            return result.ok ? { ok: true, data: result.data.data } : result
        },
        async pushState(states) {
            // remi caps this endpoint at MAX_STATES_PER_PUSH states per request; the client honors
            // that by chunking rather than by rejecting a larger fleet's tick outright.
            let accepted = 0
            let rejected = 0
            for (let offset = 0; offset < states.length; offset += MAX_STATES_PER_PUSH) {
                const chunk = states.slice(offset, offset + MAX_STATES_PER_PUSH)
                const result = await call(
                    'POST',
                    '/api/v3/fleet/state',
                    envelope(z.looseObject({ accepted: z.number().int(), rejected: z.number().int() })),
                    { bots: chunk },
                )
                if (!result.ok) return result
                accepted += result.data.data.accepted
                rejected += result.data.data.rejected
            }
            return { ok: true, data: { accepted, rejected } }
        },
        async reportEvent(event) {
            const result = await call('POST', '/api/v3/fleet/events', envelope(z.looseObject({ accepted: z.literal(true) })), event)
            return result.ok ? { ok: true, data: result.data.data } : result
        },
        async setCapabilities(caps) {
            const result = await call('POST', '/api/v3/fleet/capabilities', envelope(fleetCapabilitiesSchema), caps)
            return result.ok ? { ok: true, data: result.data.data } : result
        },
    }
}
