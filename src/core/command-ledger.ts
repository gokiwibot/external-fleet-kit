/**
 * Every command a bot has ever been asked to run, by id. This is where idempotency lives (design
 * §9.3): a known id never reaches the driver again, and the caller answers with the recorded status.
 * `accept()` and `reject()` on an id already in the ledger record nothing and return the status that
 * is already there — remi resends the same id up to three times, and a resend must never restamp a
 * command, move a terminal backwards, or erase an outcome that has not been published yet.
 *
 * `rejected` and `failed` are different things (umbrella H1): rejected never started, failed was
 * accepted and will not finish. `REPLACED` is an internal marker for a navigation displaced by a
 * newer one under `supports_command_interrupt`; the contract has no such state, so it never leaves
 * this module — `current_command` simply becomes the new command.
 *
 * THE SINGLE SLOT. `current_command` is one field, and the outcome of a command competes with the
 * navigation that is still running. Left to itself, an outcome would either stick — and remi, which
 * reads states and not a queue, would watch the running command vanish and give the work up for lost
 * — or never be published, and remi would resend or hang until the job step timed out. The invariant
 * is therefore: **every terminal status is published in at least one BotState**. remi asked for these
 * commands; it must learn how each one ended.
 *
 * So terminal statuses queue up in `unpublishedTerminals`, oldest first, `current()` returns the head
 * while the queue is non-empty, and `markPublished` pops it. Once the queue drains, the slot goes
 * back to the live command, so the queue can never starve it; with nothing live, the last status
 * published stays in the slot. That subsumes the rejection rule N2 writes on the page (a rejection is
 * just one kind of terminal) and nothing is ever shown twice, because a popped id is never re-queued.
 */
import type { BotPosition, CommandStatus, CommandType, RejectionCode } from '../contract/schemas'

export type LedgerEntry = { status: CommandStatus; type: CommandType; internalCode?: 'REPLACED'; publishedOnce: boolean }
export type Correction = { position: BotPosition; distanceM: number }

export interface CommandLedger {
    get(id: string): LedgerEntry | undefined
    accept(id: string, type: CommandType, correction?: Correction): CommandStatus
    reject(id: string, type: CommandType, code: RejectionCode, message: string, correctionDistanceM?: number): CommandStatus
    markExecuting(id: string): boolean
    /** A `failed` completion must carry the error: the contract requires one on a failed CommandStatus. */
    complete(id: string, terminal: 'succeeded', error?: undefined): boolean
    complete(id: string, terminal: 'failed', error: { code: string; message: string }): boolean
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
    /** Outcomes remi has not seen yet, oldest first. `current()` reads the head, `markPublished` pops it. */
    const unpublishedTerminals: string[] = []
    /** What the last published state carried, so the slot does not go empty once the queue drains. */
    let lastPublishedId: string | null = null
    const iso = () => new Date(deps.now()).toISOString()

    /** The command that has not finished, newest first: the loop keeps the last match in insertion order. */
    const liveEntry = (): LedgerEntry | undefined => {
        let found: LedgerEntry | undefined
        for (const entry of entries.values()) {
            if (LIVE.has(entry.status.state)) found = entry
        }
        return found
    }

    return {
        get: (id) => entries.get(id),
        accept(id, type, correction) {
            const known = entries.get(id)
            if (known) return known.status
            const status: CommandStatus = { id, state: 'accepted', accepted_at: iso() }
            if (correction) {
                status.corrected_position = correction.position
                status.correction_distance_m = correction.distanceM
            }
            entries.set(id, { status, type, publishedOnce: false })
            return status
        },
        reject(id, type, code, message, correctionDistanceM) {
            const known = entries.get(id)
            if (known) return known.status
            const status: CommandStatus = { id, state: 'rejected', rejected_at: iso(), error: { code, message } }
            if (code === 'DESTINATION_UNREACHABLE' && correctionDistanceM !== undefined) status.correction_distance_m = correctionDistanceM
            entries.set(id, { status, type, publishedOnce: false })
            unpublishedTerminals.push(id)
            return status
        },
        markExecuting(id) {
            const entry = entries.get(id)
            if (!entry || TERMINAL.has(entry.status.state) || entry.status.state === 'executing') return false
            entry.status = { ...entry.status, state: 'executing', updated_at: iso() }
            return true
        },
        complete(id: string, terminal: 'succeeded' | 'failed', error?: { code: string; message: string }): boolean {
            const entry = entries.get(id)
            if (!entry || TERMINAL.has(entry.status.state)) return false
            // The overloads above already refuse this at compile time; the runtime check is for the
            // JavaScript caller, because a failed status without an error fails commandStatusSchema
            // and would be dropped on the way out instead of telling remi how the command ended.
            if (terminal === 'failed' && !error) return false
            entry.status = withoutCorrection({ ...entry.status, state: terminal, updated_at: iso(), ...(error ? { error } : {}) })
            unpublishedTerminals.push(id)
            return true
        },
        replace(previousId) {
            const entry = entries.get(previousId)
            if (!entry || TERMINAL.has(entry.status.state)) return
            const error = { code: 'REPLACED', message: 'replaced by a newer navigate_to' }
            entry.status = withoutCorrection({ ...entry.status, state: 'failed', updated_at: iso(), error })
            entry.internalCode = 'REPLACED'
            // Deliberately not queued: REPLACED is not a contract state and must never reach remi.
            // remi itself asked for the newer navigation, so it is not waiting for this outcome.
        },
        current() {
            const head = unpublishedTerminals[0]
            if (head !== undefined) return entries.get(head)?.status ?? null
            const live = liveEntry()
            if (live) return live.status
            const last = lastPublishedId === null ? undefined : entries.get(lastPublishedId)
            return last?.status ?? null
        },
        markPublished(id) {
            const entry = entries.get(id)
            if (!entry) return
            entry.publishedOnce = true
            lastPublishedId = id
            if (unpublishedTerminals[0] === id) unpublishedTerminals.shift()
        },
        activeNavigation() {
            for (const [id, entry] of entries) {
                if (entry.type === 'navigate_to' && LIVE.has(entry.status.state)) return id
            }
            return null
        },
    }
}
