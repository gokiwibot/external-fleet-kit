/**
 * The TUI view-model. Pure: `reduce` folds bus events into bounded, newest-first rows, and the Ink
 * components only render what is here. Keeping it pure is what makes the grouping of resends and
 * the echo latency testable without a terminal (design §8, §11).
 *
 * NOTHING HERE MAY THROW ON A BAD PAYLOAD. The TUI is the partner's window onto a running fleet, and
 * a row it cannot render must not take the simulation down with it: an exception inside `reduce`
 * becomes a red line in the LOG panel, and every string a component prints is coerced here or by
 * `pad`, so an unexpected shape costs one line and nothing else.
 */
import type { CommandStatus } from '../contract/schemas'
import type { BusReplay, CommandOutcome, EventName, KitEvents } from '../core/events'
import { REPLAY_BUFFER_MAX } from '../core/events'
import type { FleetManager } from '../core/fleet-manager'
import { describeThrown } from '../net-failure'
import { REJECTION_STATUS } from '../transport/http/server'

/**
 * The manual fault controls used to live here. They moved to `../core/manual-controls` so the web
 * dashboard could drive them too without importing from `tui/` (controller ruling 1) — re-exported
 * here so nothing that already imports them from the TUI's model has to change.
 */
export {
    controlsFor,
    guardToggle,
    linkLabel,
    type ManualControls,
    manualControls,
    nextOfflinePin,
    type ToggleResult,
    type ToggleTarget,
    toggleAvailable,
} from '../core/manual-controls'

export type CommandRow = {
    commandId: string
    botId: string
    type: string
    via: 'mqtt' | 'http'
    sends: number
    firstAt: number
    lastAt: number
    outcome: string
    echoLatencyMs: number | null
}
/**
 * `id` is the row's identity for React. The EVENTS and LOG panels are newest-first, so every new
 * line shifts every index: keying on the position would tell Ink that the row at index 3 changed
 * its text when in fact a new row arrived above it. A counter that never repeats within a model is
 * the exact property the list key needs.
 */
export type EventRow = { id: number; at: number; botId: string; type: string; delivered: boolean; detail?: string }
export type LogRow = {
    id: number
    at: number
    level: 'debug' | 'info' | 'warn' | 'error'
    message: string
    botId?: string
    dropped: boolean
}
export type PublishedRow = { seq: number; at: number }

export type TuiModel = {
    maxRows: number
    commands: CommandRow[]
    events: EventRow[]
    log: LogRow[]
    /** Last published state per bot, for the "age" and "seq" columns. */
    published: Record<string, PublishedRow>
    /** States dropped by validation, per bot. */
    dropped: Record<string, number>
    /** The next `id` for an EVENTS or LOG row; see `EventRow`. */
    nextRowId: number
}

export function createModel(limits: { maxRows?: number } = {}): TuiModel {
    return { maxRows: limits.maxRows ?? 200, commands: [], events: [], log: [], published: {}, dropped: {}, nextRowId: 1 }
}

/** Every cell of every table goes through here, so a value that is not a string cannot throw at render. */
export function pad(value: string | undefined, width: number): string {
    return String(value ?? '')
        .padEnd(width)
        .slice(0, width)
}

/** A clock column that is total: an absent or nonsensical timestamp prints as a gap, it does not throw. */
export function hhmmss(ms: number): string {
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) : '--:--:--'
}

/**
 * The same map the HTTP transport answers with (Task 14), widened at the boundary so an unexpected
 * code reads as `4xx` instead of `undefined`. A second copy of the table here would let the dashboard
 * show 409 for a request that went out as a 422, and the partner would be debugging a discrepancy
 * the kit invented.
 */
const STATUS_FOR: Record<string, number | undefined> = REJECTION_STATUS

/**
 * What the COMMANDS column shows for a synchronous outcome. HTTP speaks status codes; MQTT speaks
 * states.
 */
export function outcomeLabel(outcome: CommandOutcome, via: 'mqtt' | 'http'): string {
    switch (outcome.kind) {
        case 'accepted':
            return via === 'http' ? '202 accepted' : 'accepted'
        case 'duplicate': {
            // A duplicate replays the original answer, including a rejection's 4xx (Task 14).
            if (outcome.status.state === 'rejected') {
                const code = outcome.status.error?.code ?? 'REJECTED'
                return via === 'http' ? `${STATUS_FOR[code] ?? '4xx'} ${code} (resent)` : `rejected ${code} (resent)`
            }
            return via === 'http' ? '202 duplicate' : `duplicate (${outcome.status.state})`
        }
        case 'rejected':
            return via === 'http' ? `${STATUS_FOR[outcome.code] ?? '4xx'} ${outcome.code}` : `rejected ${outcome.code}`
        case 'driver_error':
            return via === 'http' ? '503 DRIVER_ERROR' : 'no response (DRIVER_ERROR)'
        default:
            // Unreachable for a well-formed outcome, and the reason this function is TOTAL: the
            // column it feeds is rendered with `.startsWith`, so returning `undefined` here would
            // move the crash into the renderer.
            return 'unknown outcome'
    }
}

function cap<T>(rows: T[], max: number): T[] {
    return rows.length > max ? rows.slice(0, max) : rows
}

function logRow(model: TuiModel, row: Omit<LogRow, 'id'>): TuiModel {
    return { ...model, log: cap([{ ...row, id: model.nextRowId }, ...model.log], model.maxRows), nextRowId: model.nextRowId + 1 }
}

function eventRow(model: TuiModel, row: Omit<EventRow, 'id'>): TuiModel {
    return { ...model, events: cap([{ ...row, id: model.nextRowId }, ...model.events], model.maxRows), nextRowId: model.nextRowId + 1 }
}

export function reduce<K extends EventName>(model: TuiModel, name: K, payload: KitEvents[K], nowMs: number): TuiModel {
    try {
        return fold(model, name, payload, nowMs)
    } catch (error) {
        // A malformed or unexpected event costs ONE red line. The alternative — letting it out of
        // here — unmounts Ink from inside a bus handler and takes a running fleet with it, because
        // the partner's simulation lives in the same process as the screen. `describeThrown` is what
        // says it, and it quotes no message, so nothing a payload carried can reach the screen.
        return logRow(model, {
            at: nowMs,
            level: 'error',
            message: `the TUI could not read a '${String(name)}' event: ${describeThrown(error)}`,
            dropped: false,
        })
    }
}

function fold<K extends EventName>(model: TuiModel, name: K, payload: KitEvents[K], nowMs: number): TuiModel {
    switch (name) {
        case 'command.received': {
            const p = payload as KitEvents['command.received']
            const existing = model.commands.find((c) => c.commandId === p.command.id && c.botId === p.botId)
            if (existing) {
                const updated = { ...existing, sends: existing.sends + 1, lastAt: p.receivedAt }
                return { ...model, commands: [updated, ...model.commands.filter((c) => c !== existing)] }
            }
            const row: CommandRow = {
                commandId: p.command.id,
                botId: p.botId,
                type: p.command.type,
                via: p.via,
                sends: 1,
                firstAt: p.receivedAt,
                lastAt: p.receivedAt,
                outcome: 'pending',
                echoLatencyMs: null,
            }
            return { ...model, commands: cap([row, ...model.commands], model.maxRows) }
        }
        case 'command.outcome': {
            const p = payload as KitEvents['command.outcome']
            return {
                ...model,
                commands: model.commands.map((c) =>
                    c.commandId === p.commandId && c.botId === p.botId ? { ...c, outcome: outcomeLabel(p.outcome, c.via) } : c,
                ),
            }
        }
        case 'command.echoed': {
            const p = payload as KitEvents['command.echoed']
            return {
                ...model,
                commands: model.commands.map((c) =>
                    c.commandId === p.commandId && c.botId === p.botId && c.echoLatencyMs === null
                        ? { ...c, echoLatencyMs: p.echoLatencyMs }
                        : c,
                ),
            }
        }
        case 'event.emitted': {
            const p = payload as KitEvents['event.emitted']
            return eventRow(model, {
                at: nowMs,
                botId: p.botId,
                type: p.event.type,
                delivered: p.delivered,
                ...(p.detail === undefined ? {} : { detail: String(p.detail) }),
            })
        }
        case 'state.published': {
            const p = payload as KitEvents['state.published']
            return { ...model, published: { ...model.published, [p.botId]: { seq: p.state.seq ?? 0, at: nowMs } } }
        }
        case 'state.served': {
            // HTTP polling: nothing is published, but the state DID reach remi. Same column, so the
            // age reads as freshness instead of a permanent "never" on a perfectly healthy fleet.
            const p = payload as KitEvents['state.served']
            return { ...model, published: { ...model.published, [p.botId]: { seq: p.state.seq ?? 0, at: nowMs } } }
        }
        case 'state.dropped': {
            const p = payload as KitEvents['state.dropped']
            const row = {
                at: nowMs,
                level: 'error' as const,
                message: `state dropped for ${p.botId}: ${p.reason}`,
                botId: p.botId,
                dropped: true,
            }
            return {
                ...logRow(model, row),
                dropped: { ...model.dropped, [p.botId]: (model.dropped[p.botId] ?? 0) + 1 },
            }
        }
        case 'link.changed': {
            const p = payload as KitEvents['link.changed']
            const detail = p.reason ? ` (${String(p.reason)})` : ''
            return logRow(model, {
                at: nowMs,
                level: 'info',
                message: `${p.botId} ${p.connected ? 'connected' : 'disconnected'}${detail}`,
                botId: p.botId,
                dropped: false,
            })
        }
        case 'log': {
            const p = payload as KitEvents['log']
            return logRow(model, { at: nowMs, level: p.level, message: String(p.message), botId: p.botId, dropped: false })
        }
        default:
            return model
    }
}

/**
 * Folds what the bus buffered BEFORE this screen existed (`EventBus.replay`, bounded by
 * `REPLAY_BUFFER_MAX`). Every event keeps the time it was emitted, not the time it was replayed, so
 * the LOG panel reads as one timeline. When the buffer overflowed, the gap is stated in the panel
 * rather than left to be inferred from a jump in the clock column — and it is stated LAST, so in a
 * newest-first list it sits exactly where the missing events would have been.
 */
export function applyReplay(model: TuiModel, replay: BusReplay, nowMs: number): TuiModel {
    let next = model
    for (const event of replay.events) next = reduce(next, event.name, event.payload as never, event.at)
    if (replay.dropped > 0) {
        const message = `replay buffer full (${REPLAY_BUFFER_MAX} events): ${replay.dropped} events between the lines below and this one were not kept`
        next = reduce(next, 'log', { level: 'warn', message }, nowMs)
    }
    return next
}

export type BotRow = {
    botId: string
    connected: boolean
    available: boolean
    batteryPercentage: number
    door: string
    command: string
    lastPublishedAgeMs: number | null
    seq: number | null
    dropped: number
    /** Set when reading the driver behind this bot threw; the other columns are then meaningless. */
    driverError: string | null
}

/**
 * One row per bot from the live runtimes plus what the model remembers about their publishes.
 *
 * THE DRIVER IS SOMEBODY ELSE'S CODE. `runtime.snapshot()` is a direct pass-through to the
 * `RobotDriver` the partner wrote (`bot-runtime.ts`), and this runs on every 500 ms tick: a driver
 * that throws from it would take Ink down from inside the render and the partner would lose the
 * simulation they were watching — over a panel that could not draw one row. The rest of the kit
 * already treats a driver throw as an expected case (HTTP answers `503 DRIVER_ERROR`), and this is
 * the same rule for the screen: that bot's row degrades to `driver error`, EVERY OTHER ROW STILL
 * RENDERS, and what the kit knows without asking the driver — the age and the seq it recorded when
 * the state was published — stays on the row.
 *
 * `step` names the call that threw rather than guessing, and `describeThrown` quotes no message, so
 * nothing the driver was holding reaches the terminal.
 */
export function botRows(manager: FleetManager, model: TuiModel, nowMs: number): BotRow[] {
    return manager.bots().map((runtime) => {
        const published = model.published[runtime.botId]
        const known = {
            botId: runtime.botId,
            lastPublishedAgeMs: published ? nowMs - published.at : null,
            seq: published?.seq ?? null,
        }
        let step = 'snapshot'
        try {
            const snap = runtime.snapshot()
            step = 'currentCommand'
            const current = runtime.currentCommand()
            step = 'dropped'
            const dropped = runtime.dropped()
            return {
                ...known,
                connected: snap.connected,
                available: snap.available,
                batteryPercentage: snap.batteryPercentage,
                door: snap.door,
                command: current ? `${shortId(current)} ${current.state}` : '—',
                dropped,
                driverError: null,
            }
        } catch (error) {
            return {
                ...known,
                connected: false,
                available: false,
                batteryPercentage: 0,
                door: '?',
                command: 'driver error',
                dropped: 0,
                driverError: `${step}() threw: ${describeThrown(error)}`,
            }
        }
    })
}

/**
 * Which failing rows deserve a LOG line right now. A driver that throws does it on EVERY tick — twice
 * a second, for ever — so the line is written once per failure and not again until that bot has read
 * cleanly at least once. `reported` is the caller's memory (a ref in the hook) and is updated here:
 * a bot that recovers is forgotten, so a second failure later is reported again rather than swallowed.
 */
export function reportableDriverFailures(rows: BotRow[], reported: Set<string>): Array<{ botId: string; message: string }> {
    const fresh: Array<{ botId: string; message: string }> = []
    for (const row of rows) {
        if (row.driverError === null) {
            reported.delete(row.botId)
            continue
        }
        if (reported.has(row.botId)) continue
        reported.add(row.botId)
        fresh.push({
            botId: row.botId,
            message: `${row.botId}: reading its driver failed, ${row.driverError}. The rest of the fleet is unaffected.`,
        })
    }
    return fresh
}

function shortId(status: CommandStatus): string {
    return status.id.length > 18 ? `…${status.id.slice(-17)}` : status.id
}
