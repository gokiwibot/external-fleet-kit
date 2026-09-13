/**
 * A RemiClient that answers from memory. Two consumers, which is why it is a module and not a
 * fixture inside a test file: the FleetManager test (Task 8) and `efk start --demo` (Task 16), which
 * lets someone look at the TUI and the dashboard with no credentials and no network.
 *
 * It is NOT a mode anyone should run against real robots: every answer is invented, nothing reaches
 * remi, and the kit shouts about it in the banner, in the log and in `efk check` C2.
 */
import type { BotEvent, BotState, FleetBotMirror, FleetConfigResponse } from '../contract/schemas'
import type { Delivery, RemiClient } from '../remi/client'

export const DEMO_ROSTER = ['ACME-0001', 'ACME-0002', 'ACME-0003']

export function createFakeRemiClient(opts: { roster?: string[]; namespace?: string; transport?: 'mqtt' | 'http' } = {}): RemiClient {
    const roster = opts.roster ?? DEMO_ROSTER
    const config: FleetConfigResponse = {
        namespace: opts.namespace ?? 'acme',
        bot_id_prefix: 'ACME-',
        transport: opts.transport ?? 'mqtt',
        base_url: null,
        token_set: false,
        poll_interval_active_ms: 2_000,
        poll_interval_idle_ms: 15_000,
        max_bots: 40,
        contract_version: '2026-09',
    }
    const mirror = (botId: string): FleetBotMirror => ({
        bot_id: botId,
        location_id: 'DEMO-LOCATION',
        assignable: false,
        blocked_by: ['disconnected'],
        state_age_ms: null,
        current_job_id: null,
    })
    const delivery: Delivery = { id: 'DEMO-0001', state: 'pending', bot: null, arriving: null, pickup: {}, dropoff: {} }
    return {
        getFleetConfig: async () => ({ ok: true, data: config }),
        listFleetBots: async () => ({ ok: true, data: roster.map(mirror) }),
        listDeliveries: async () => ({ ok: true, data: null }),
        createDelivery: async () => ({ ok: false, status: 0, code: 'DEMO_MODE', message: 'demo mode creates nothing in remi' }),
        getDelivery: async () => ({ ok: true, data: delivery }),
        pushState: async (states: BotState[]) => ({ ok: true, data: { accepted: states.length, rejected: 0 } }),
        reportEvent: async (_event: BotEvent) => ({ ok: true, data: { accepted: true } }),
    }
}
