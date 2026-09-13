import type { BotCommand, BotEvent, BotState, FleetCapabilities } from '../contract/schemas'
import type { BotRuntime } from '../core/bot-runtime'
import type { CommandOutcome } from '../core/events'

/** What the core needs from a pipe. MQTT and HTTP implement it; the core never knows which one it has. */
export interface Transport {
    readonly kind: 'mqtt' | 'http'
    start(bots: BotRuntime[]): Promise<void>
    stop(): Promise<void>
    /**
     * True when the state really left the process. False is a legitimate answer, not an error: a bot
     * the link policy has taken offline has no connection, and HTTP without push publishes nothing
     * at all because remi polls. The manager uses this to decide whether `state.published` happened —
     * emitting it unconditionally is how a dashboard ends up showing a steady publish rate for a
     * fleet that has been disconnected for ten minutes.
     */
    publishState(botId: string, state: BotState): Promise<boolean>
    publishEvent(botId: string, event: BotEvent): Promise<boolean>
    publishCapabilities(doc: FleetCapabilities): Promise<void>
    /** End of tick. The HTTP transport sends its accumulated batch here; MQTT resolves immediately. */
    flushTick(): Promise<void>
    onCommand(handler: (botId: string, command: BotCommand) => Promise<CommandOutcome>): void
}
