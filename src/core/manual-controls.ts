/**
 * The manual fault controls: available/door/link/blocked. Originally lived only in
 * `src/tui/model.ts`; the web dashboard now drives the same four controls, so
 * they live here — a module BOTH interfaces import — instead of the web reaching into `src/tui/`,
 * which would wire a dependency between two sibling interfaces that must not diverge.
 *
 * This crosses the kit's observer rule ("TUI, web and log are observers of the bus; no logic lives in them") on
 * purpose, for both interfaces now, and it is written down in the kit's README rather than left as a
 * silent side effect.
 */

import type { DriverSnapshot, RobotDriver } from '../driver/robot-driver'
import { describeThrown } from '../net-failure'
import type { FleetManager } from './fleet-manager'

/**
 * The manual fault keys only work on a driver that exposes the simulated controls.
 *
 * `setOffline` takes `boolean | null` because that is what the simulated driver takes, and the `null`
 * is the half that matters: `true`/`false` PIN the link, and only `null` hands it back to the
 * scenario. Narrowing it to a boolean here — as an earlier draft did — is how one press of `o` on a
 * bot in `offline-flapping` stopped it flapping for the rest of the run, with no way back.
 */
export type ManualControls = {
    setAvailable(value: boolean): void
    toggleDoorLocally(): void
    setOffline(value: boolean | null): void
    emitBlocked(reason: string, message?: string): void
    emitUnblocked(): void
}

export function manualControls(driver: RobotDriver | undefined): ManualControls | null {
    if (!driver) return null
    // Five property reads on an object the partner built, from inside a render body or a request
    // handler. A getter that throws there would take the caller down with it, so a driver this
    // cannot inspect is simply a driver without manual controls — which is what both interfaces
    // already know how to say.
    try {
        const d = driver as Partial<ManualControls>
        if (
            typeof d.setAvailable === 'function' &&
            typeof d.toggleDoorLocally === 'function' &&
            typeof d.setOffline === 'function' &&
            typeof d.emitBlocked === 'function' &&
            typeof d.emitUnblocked === 'function'
        ) {
            return d as ManualControls
        }
        return null
    } catch {
        return null
    }
}

/** The same thing for a render body or a request handler, where the lookup itself is one more call that must not throw. */
export function controlsFor(manager: FleetManager, botId: string | undefined): ManualControls | null {
    if (!botId) return null
    try {
        return manualControls(manager.driver(botId))
    } catch {
        return null
    }
}

/**
 * Runs a manual fault key. The controls belong to whatever driver `efk.config.ts` built, so a throw
 * here would leave the caller's input handler (Ink's keyboard loop, or an HTTP route) and, in the
 * TUI's case, unmount a running simulation — the same harm a malformed event would do, through the
 * keyboard instead. It costs the keystroke (or the request) and one note, never the screen or the
 * server.
 */
export function guardToggle(botId: string, action: () => void): string | null {
    try {
        action()
        return null
    } catch (error) {
        return `${botId} refused that key: ${describeThrown(error)}`
    }
}

/**
 * Where `o` (or the web's "link" button) goes next. THREE states, not two: the scenario is in charge
 * (`null`), the link is pinned down (`true`), the link is pinned up (`false`). Cycling back to `null`
 * is the only way a bot returns to the behaviour its scenario describes, and the `*` in the link
 * column is what tells a pinned `up` apart from a scenario that happens to be up.
 */
export function nextOfflinePin(current: boolean | null | undefined): boolean | null {
    if (current === null || current === undefined) return true
    return current ? false : null
}

/** What the link column prints: the reported state, marked when a human pinned it. */
export function linkLabel(connected: boolean, pin: boolean | null | undefined): string {
    const state = connected ? 'up' : 'down'
    return pin === null || pin === undefined ? state : `${state}*`
}

/** The part of a `BotRuntime` the toggles need. Named so a test does not have to build a whole fleet. */
export type ToggleTarget = { readonly botId: string; snapshot(): DriverSnapshot; touch(): void }

export type ToggleResult = { requested: boolean; applied: boolean; note: string | null }

/**
 * Flips `available` and READS BACK whether the driver honoured it.
 *
 * Availability in the simulated driver is `(override ?? scenario.available) && !battery.unavailable()`,
 * so on a bot whose battery is under the scenario's threshold `setAvailable(true)` changes nothing:
 * the key looks dead and the partner is left guessing. The check is the exact property — what was
 * asked for against what the snapshot says afterwards — and not a battery threshold this module
 * would have to guess at, because the threshold lives in the scenario and a partner's own driver may
 * refuse for some entirely different reason of its own. Whatever the reason, the answer is the same:
 * say that the toggle did not take, and show the battery reading next to it.
 */
export function toggleAvailable(controls: ManualControls, bot: ToggleTarget): ToggleResult {
    const requested = !bot.snapshot().available
    controls.setAvailable(requested)
    bot.touch()
    const after = bot.snapshot()
    const applied = after.available === requested
    if (applied) return { requested, applied, note: null }
    const state = after.available ? 'yes' : 'no'
    const note =
        `'a' had no effect on ${bot.botId}: the driver still reports avail=${state} at ${after.batteryPercentage}% battery. ` +
        'In the simulated driver a battery below the scenario threshold outranks this toggle.'
    return { requested, applied, note }
}
