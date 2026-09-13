/**
 * The Ink TUI. Task 17 replaces the BODY; the signature here is the final one.
 *
 * `onQuit` is how `q` leaves: it calls the single `shutdown()` in `efk start`. It deliberately does
 * NOT raise a synthetic SIGINT — that is a process-wide side effect fired from a UI component, and
 * it fights with anything else the process has installed on that signal.
 */
import type { EventBus } from '../core/events'
import type { FleetManager } from '../core/fleet-manager'

export async function startTui(_opts: {
    bus: EventBus
    manager: FleetManager
    roster: string[]
    demo: boolean
    onQuit: () => void
}): Promise<() => void> {
    return () => {}
}
