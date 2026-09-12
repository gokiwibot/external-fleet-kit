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

export interface EventBus {
    emit<K extends EventName>(name: K, payload: KitEvents[K]): void
    on<K extends EventName>(name: K, handler: Handler<K>): () => void
    onAny(handler: (name: EventName, payload: KitEvents[EventName]) => void): () => void
}

export function createEventBus(): EventBus {
    const handlers = new Map<EventName, Set<(payload: never) => void>>()
    const any = new Set<(name: EventName, payload: KitEvents[EventName]) => void>()
    return {
        emit(name, payload) {
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
    }
}
