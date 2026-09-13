/**
 * The internal bus. TUI, web dashboard and log are OBSERVERS of this bus and hold no logic; the
 * core emits and never listens to itself. Payloads are plain data so the web SSE can JSON them.
 */
import type { BotCommand, BotEvent, BotState, CommandStatus, RejectionCode } from '../contract/schemas'

export type CommandOutcome =
    | { kind: 'accepted'; status: CommandStatus }
    | { kind: 'rejected'; code: RejectionCode; message: string; correctionDistanceM?: number }
    | { kind: 'driver_error'; message: string }
    | { kind: 'duplicate'; status: CommandStatus }

export type KitEvents = {
    /** The state really left the process (MQTT publish, or an HTTP push remi accepted). */
    'state.published': { botId: string; state: BotState; transport: 'mqtt' | 'http' }
    /**
     * HTTP mode without push: nothing is ever "published" — remi polls. This fires when `GET /bots`
     * handed the state over, so the TUI and the dashboard show freshness instead of a permanent
     * "never published" for a perfectly healthy fleet.
     */
    'state.served': { botId: string; state: BotState }
    'state.dropped': { botId: string; reason: string }
    'command.received': { botId: string; command: BotCommand; via: 'mqtt' | 'http'; receivedAt: number }
    'command.outcome': { botId: string; commandId: string; outcome: CommandOutcome; latencyMs: number }
    'command.echoed': { botId: string; commandId: string; echoLatencyMs: number }
    'event.emitted': { botId: string; event: BotEvent; delivered: boolean; detail?: string }
    'link.changed': { botId: string; connected: boolean; reason?: string }
    log: { level: 'debug' | 'info' | 'warn' | 'error'; message: string; botId?: string; data?: Record<string, unknown> }
}

export type EventName = keyof KitEvents
export type Handler<K extends EventName> = (payload: KitEvents[K]) => void

/** One buffered event, with the time it was emitted — not the time it is replayed. */
export type BufferedEvent = { [K in EventName]: { name: K; payload: KitEvents[K]; at: number } }[EventName]

/** What `replay()` answers: the events that were kept, oldest first, and how many were not. */
export type BusReplay = { events: BufferedEvent[]; dropped: number }

/**
 * How many events the bus keeps for an observer that is not there yet.
 *
 * THE OLDEST ARE THE ONES WORTH KEEPING. Nothing observes the bus until the TUI or the dashboard
 * mounts, and by then the connection, the roster and the capabilities have already happened — which
 * is exactly the sequence that explains a start that went wrong. So when the bound is reached the
 * buffer STOPS (it does not drop its head to make room), and every event past it is counted instead:
 * a late observer gets the beginning of the run plus an explicit line saying how much is missing
 * between that beginning and the live stream. Dropping the oldest would have thrown away the only
 * part a partner cannot get back.
 */
export const REPLAY_BUFFER_MAX = 500

export interface EventBus {
    emit<K extends EventName>(name: K, payload: KitEvents[K]): void
    on<K extends EventName>(name: K, handler: Handler<K>): () => void
    onAny(handler: (name: EventName, payload: KitEvents[EventName]) => void): () => void
    /**
     * Everything emitted since the bus was created, oldest first, bounded by `REPLAY_BUFFER_MAX`.
     * Read-only and repeatable: it drains nothing, so the TUI and the dashboard can each catch up
     * whichever of them mounts first, and a surface that remounts catches up again.
     */
    replay(): BusReplay
}

export function createEventBus(deps: { now?: () => number } = {}): EventBus {
    const now = deps.now ?? Date.now
    const handlers = new Map<EventName, Set<(payload: never) => void>>()
    const any = new Set<(name: EventName, payload: KitEvents[EventName]) => void>()
    const buffered: BufferedEvent[] = []
    let dropped = 0
    return {
        emit(name, payload) {
            // Before dispatch, so an event a handler emits in reaction lands after the one that
            // caused it. The cast is the generic-to-union one TypeScript cannot see through: `name`
            // and `payload` are correlated by K here, and that correlation is what `BufferedEvent`
            // spells out member by member.
            if (buffered.length < REPLAY_BUFFER_MAX) buffered.push({ name, payload, at: now() } as BufferedEvent)
            else dropped += 1
            for (const handler of handlers.get(name) ?? []) (handler as (p: typeof payload) => void)(payload)
            for (const handler of any) handler(name, payload)
        },
        on(name, handler) {
            const set = handlers.get(name) ?? new Set()
            set.add(handler as (payload: never) => void)
            handlers.set(name, set)
            return () => set.delete(handler as (payload: never) => void)
        },
        onAny(handler) {
            any.add(handler)
            return () => any.delete(handler)
        },
        replay: () => ({ events: [...buffered], dropped }),
    }
}
