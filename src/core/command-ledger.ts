/**
 * Every command a bot has ever been asked to run, by id. This is where idempotency lives (design
 * §9.3): a known id never reaches the driver again, and the caller answers with the recorded status.
 *
 * `rejected` and `failed` are different things (umbrella H1): rejected never started, failed was
 * accepted and will not finish. `REPLACED` is an internal marker for a navigation displaced by a
 * newer one under `supports_command_interrupt`; the contract has no such state, so it never leaves
 * this module — `current_command` simply becomes the new command.
 *
 * THE SINGLE SLOT. `current_command` is one field, and a rejection competes with the navigation that
 * is still running. Left to itself, a rejection would either stick — and remi, which reads states and
 * not a queue, would watch the running command vanish and give the work up for lost — or never be
 * published, and remi would resend. So: a rejection owns the slot until it has been published in at
 * least one BotState (`markPublished`), and then the slot returns to the still-running command. With
 * nothing else running, the rejection stays. N2 writes the same sentence on the page.
 *
 * That rule has two halves, and both are enforced here. The release half is `current()`, which hands
 * the slot back once `publishedOnce` is set. The hold half is `holdsUnpublishedRejection()`: a
 * command recorded while a rejection is still waiting for its first publish does NOT take the slot.
 * Without it, a command accepted inside the same 250 ms tick would evict the rejection before remi
 * ever saw it, remi would never learn its command was refused, and the job step would hang until it
 * timed out.
 */
import type { BotPosition, CommandStatus, CommandType, RejectionCode } from '../contract/schemas'

export type LedgerEntry = { status: CommandStatus; type: CommandType; internalCode?: 'REPLACED'; publishedOnce: boolean }
export type Correction = { position: BotPosition; distanceM: number }

export interface CommandLedger {
    get(id: string): LedgerEntry | undefined
    accept(id: string, type: CommandType, correction?: Correction): CommandStatus
    reject(id: string, type: CommandType, code: RejectionCode, message: string, correctionDistanceM?: number): CommandStatus
    markExecuting(id: string): boolean
    complete(id: string, terminal: 'succeeded' | 'failed', error?: { code: string; message: string }): boolean
    replace(previousId: string): void
    /** What goes into BotState.current_command, applying the single-slot rule above. */
    current(): CommandStatus | null
    /** Called by BotRuntime with the current_command.id of the state it just handed to the transport. */
    markPublished(id: string): void
    /** The navigate_to that is accepted or executing right now, if any. */
    activeNavigation(): string | null
}

const TERMINAL = new Set<CommandStatus['state']>(['succeeded', 'failed', 'rejected'])
const LIVE = new Set<CommandStatus['state']>(['accepted', 'executing'])

/**
 * The correction described where the bot was heading; on a terminal it would describe a place it
 * already left, and the contract scopes both fields to accepted/executing.
 */
function withoutCorrection(status: CommandStatus): CommandStatus {
    const { corrected_position: _position, correction_distance_m: _distance, ...rest } = status
    return rest
}

export function createCommandLedger(deps: { now: () => number }): CommandLedger {
    const entries = new Map<string, LedgerEntry>()
    let currentId: string | null = null
    const iso = () => new Date(deps.now()).toISOString()

    /** The most recently recorded command that has not finished. Insertion order, newest first. */
    const liveEntry = (): LedgerEntry | undefined => {
        let found: LedgerEntry | undefined
        for (const entry of entries.values()) {
            if (LIVE.has(entry.status.state)) found = entry
        }
        return found
    }

    /** The hold half of the single-slot rule: a rejection remi has not seen yet cannot be displaced. */
    const holdsUnpublishedRejection = (): boolean => {
        const holder = currentId === null ? undefined : entries.get(currentId)
        return holder !== undefined && holder.status.state === 'rejected' && !holder.publishedOnce
    }

    return {
        get: (id) => entries.get(id),
        accept(id, type, correction) {
            const status: CommandStatus = { id, state: 'accepted', accepted_at: iso() }
            if (correction) {
                status.corrected_position = correction.position
                status.correction_distance_m = correction.distanceM
            }
            entries.set(id, { status, type, publishedOnce: false })
            if (!holdsUnpublishedRejection()) currentId = id
            return status
        },
        reject(id, type, code, message, correctionDistanceM) {
            const status: CommandStatus = { id, state: 'rejected', rejected_at: iso(), error: { code, message } }
            if (code === 'DESTINATION_UNREACHABLE' && correctionDistanceM !== undefined) status.correction_distance_m = correctionDistanceM
            entries.set(id, { status, type, publishedOnce: false })
            if (!holdsUnpublishedRejection()) currentId = id
            return status
        },
        markExecuting(id) {
            const entry = entries.get(id)
            if (!entry || TERMINAL.has(entry.status.state) || entry.status.state === 'executing') return false
            entry.status = { ...entry.status, state: 'executing', updated_at: iso() }
            return true
        },
        complete(id, terminal, error) {
            const entry = entries.get(id)
            if (!entry || TERMINAL.has(entry.status.state)) return false
            entry.status = withoutCorrection({ ...entry.status, state: terminal, updated_at: iso(), ...(error ? { error } : {}) })
            // A command that finishes while a rejection is sitting in the slot must still be visible.
            if (currentId !== id) {
                const holder = currentId === null ? undefined : entries.get(currentId)
                if (!holder || (holder.status.state === 'rejected' && holder.publishedOnce)) currentId = id
            }
            return true
        },
        replace(previousId) {
            const entry = entries.get(previousId)
            if (!entry || TERMINAL.has(entry.status.state)) return
            const error = { code: 'REPLACED', message: 'replaced by a newer navigate_to' }
            entry.status = withoutCorrection({ ...entry.status, state: 'failed', updated_at: iso(), error })
            entry.internalCode = 'REPLACED'
        },
        current() {
            if (!currentId) return null
            const entry = entries.get(currentId)
            if (!entry) return null
            if (entry.status.state === 'rejected' && entry.publishedOnce) {
                const live = liveEntry()
                if (live) return live.status
            }
            return entry.status
        },
        markPublished(id) {
            const entry = entries.get(id)
            if (entry) entry.publishedOnce = true
        },
        activeNavigation() {
            for (const [id, entry] of entries) {
                if (entry.type === 'navigate_to' && LIVE.has(entry.status.state)) return id
            }
            return null
        },
    }
}
