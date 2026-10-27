/**
 * The cargo door, four modes. `full` is bot-sim's `normal` renamed; `boolean` is new
 * and is what a partner with a `lid.isOpen` boolean publishes — no transients ever — which is why
 * the remi bridge synthesises them. `stalled` and `ignore` are faults.
 */
import type { DoorState } from '../../contract/schemas'
import type { BotScenario } from './scenario'

export interface Door {
    /**
     * Returns TRUE when a transition was started, FALSE when there was nothing to do (the lid is
     * already where it was asked to be, the bot has no door, or the mode is `ignore`). The caller
     * needs that answer: a `set_door: closed` on a closed door must be reported `succeeded` on the
     * spot, because no transition will ever end and there is nothing left to wait for. Getting this
     * wrong leaves the command hanging until remi's 25 s door timeout, on the most ordinary input
     * there is — remi closes the door at the end of every single delivery.
     */
    command(target: 'open' | 'closed'): boolean
    /** Advances the state machine; returns true when the REPORTED value changed. */
    tick(): boolean
    reported(): DoorState
    /**
     * Whether the lid is still moving. `reported()` is not enough to tell: in `boolean` mode it says
     * `closed` all the way through an opening, so a caller waiting on the reported value alone would
     * answer `set_door` before the lid had moved at all.
     */
    pending(): boolean
}

export function createDoor(spec: BotScenario['door'], now: () => number): Door {
    let physical: 'opened' | 'closed' = 'closed'
    let reported: DoorState = spec.hasDoor ? 'closed' : 'unsupported'
    let transition: { target: 'opened' | 'closed'; endsAt: number } | null = null

    const compute = (): DoorState => {
        if (!spec.hasDoor) return 'unsupported'
        if (spec.mode === 'stalled' && transition) return 'stalled'
        if (!transition) return physical
        if (spec.mode === 'boolean') return physical
        return transition.target === 'opened' ? 'opening' : 'closing'
    }

    return {
        command(target) {
            if (!spec.hasDoor || spec.mode === 'ignore') return false
            const wanted = target === 'open' ? 'opened' : 'closed'
            if (wanted === physical && !transition) return false
            transition = { target: wanted, endsAt: now() + spec.transitionMs }
            return true
        },
        tick() {
            if (transition && spec.mode !== 'stalled' && now() >= transition.endsAt) {
                physical = transition.target
                transition = null
            }
            const next = compute()
            const changed = next !== reported
            reported = next
            return changed
        },
        reported: () => reported,
        pending: () => transition !== null,
    }
}
