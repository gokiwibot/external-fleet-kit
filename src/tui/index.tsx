import { render } from 'ink'
import type { EventBus } from '../core/events'
import type { FleetManager } from '../core/fleet-manager'
import { App } from './app'

/**
 * Mounts the TUI; the returned function unmounts it. `q` calls `opts.onQuit`, which is `efk start`'s
 * single `shutdown` — the TUI does not raise a synthetic SIGINT and does not know how the process
 * ends. `exitOnCtrlC: false` is what lets Ctrl+C go through the same path instead of Ink's own.
 */
export async function startTui(opts: {
    bus: EventBus
    manager: FleetManager
    roster: string[]
    demo: boolean
    onQuit: () => void
}): Promise<() => void> {
    const instance = render(<App bus={opts.bus} manager={opts.manager} demo={opts.demo} onQuit={opts.onQuit} />, { exitOnCtrlC: false })
    return () => instance.unmount()
}
