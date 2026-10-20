/**
 * `efk order`: create a test delivery on the sandbox and follow it. Needs the `delivery` scope (C7).
 *
 * The body is the real one from the Delivery API page (`docs/delivery-api/data.ts`, `create-delivery`
 * plus the `Point`, `Package` and `Item` types), not an approximation:
 *  - `pickup`/`dropoff` use the REFERENCE form of `Point` (`external_id`), because the kit is given
 *    sandbox points, not coordinates.
 *  - `location_id` is only strictly required when a point is raw coordinates, but sending it makes
 *    the request self-describing in a log and costs nothing.
 *  - `packages` must be non-empty; `Package` has no required field of its own, and an `Item` needs
 *    `name` and `quantity`. One package with one item is the smallest honest order.
 *  - `tags: ["test"]` is what the page asks for to keep trial deliveries out of production metrics;
 *    `external-fleet-kit` is ours, so these are findable later.
 *  - `external_id` must be unique among active deliveries, hence the timestamp; `now` is injected so
 *    the test can assert the exact body.
 */
import type { Delivery, RemiClient, Result } from '../remi/client'
import type { Env } from './env'

/**
 * `SANDBOX_LOCATION_ID` is optional in the schema — a production fleet has no sandbox — so this is
 * the one command that cannot run without it. Refused here with the variable's name, rather than
 * sending `location_id: undefined` and letting remi answer with a validation error about a field the
 * partner never typed.
 */
export function createOrder(remi: RemiClient, env: Env, name: string, now: () => number = Date.now): Promise<Result<Delivery>> {
    const locationId = env.SANDBOX_LOCATION_ID
    if (locationId === undefined)
        return Promise.resolve({
            ok: false,
            status: 0,
            code: 'SANDBOX_NOT_CONFIGURED',
            message: 'SANDBOX_LOCATION_ID is not set in your .env; `efk order` creates deliveries on the sandbox and needs it',
        })
    return remi.createDelivery({
        name,
        external_id: `efk-${now()}`,
        location_id: locationId,
        pickup: { external_id: env.SANDBOX_PICKUP_EXTERNAL_ID },
        dropoff: { external_id: env.SANDBOX_DROPOFF_EXTERNAL_ID },
        packages: [{ reference: 'efk-1', items: [{ name: 'efk test package', quantity: 1 }] }],
        tags: ['test', 'external-fleet-kit'],
    })
}

const TERMINAL = new Set(['delivered', 'canceled', 'returned'])

export async function watchOrder(
    remi: RemiClient,
    id: string,
    opts: {
        intervalMs: number
        timeoutMs: number
        onState: (d: Delivery) => void
        sleep?: (ms: number) => Promise<void>
        now?: () => number
    },
): Promise<'delivered' | 'canceled' | 'returned' | 'timeout' | 'error'> {
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    const now = opts.now ?? Date.now
    const started = now()
    let last = ''
    while (now() - started <= opts.timeoutMs) {
        const result = await remi.getDelivery(id)
        if (!result.ok) return 'error'
        if (result.data.state !== last) {
            last = result.data.state
            opts.onState(result.data)
        }
        if (TERMINAL.has(last)) return last as 'delivered' | 'canceled' | 'returned'
        await sleep(opts.intervalMs)
    }
    return 'timeout'
}
