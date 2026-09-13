/**
 * The web dashboard. Task 18 replaces the BODY; the signature here is the final one.
 * It binds 127.0.0.1 by default (`--web-host` widens it), so a dashboard is not exposed by accident.
 */
import type { EventBus } from '../core/events'
import type { FleetManager } from '../core/fleet-manager'

export async function startWeb(_opts: {
    bus: EventBus
    manager: FleetManager
    host: string
    port: number
    demo: boolean
}): Promise<() => Promise<void>> {
    return async () => {}
}
