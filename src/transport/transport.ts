import type { BotCommand, BotEvent, BotState } from '../contract/schemas'
import type { BotRuntime } from '../core/bot-runtime'
import type { CommandOutcome } from '../core/events'

/** What the core needs from a pipe. MQTT and HTTP implement it; the core never knows which one it has. */
export interface Transport {
    readonly kind: 'mqtt' | 'http'
    start(bots: BotRuntime[]): Promise<void>
    /**
     * The fleet changed while running: remi registered, retired or remapped a bot and the manager
     * rebuilt only what changed (FleetManager, THE ROSTER IS RE-READ). A transport that keeps its
     * own view of the fleet — the HTTP server answers `GET /bots` from it, MQTT holds one connection
     * per bot — has to be told, or it keeps serving a fleet that no longer exists.
     */
    setBots(bots: BotRuntime[]): Promise<void>
    stop(): Promise<void>
    /**
     * True when the state really left the process. False is a legitimate answer, not an error: a bot
     * the link policy has taken offline has no connection, HTTP without push publishes nothing at all
     * because remi polls, and HTTP WITH push has only buffered the state for the tick's batch — it
     * confirms later, through `BotRuntime.confirmPublished`, once remi has actually taken the batch. The manager uses this to decide whether `state.published` happened —
     * emitting it unconditionally is how a dashboard ends up showing a steady publish rate for a
     * fleet that has been disconnected for ten minutes.
     */
    publishState(botId: string, state: BotState): Promise<boolean>
    publishEvent(botId: string, event: BotEvent): Promise<boolean>
    /** End of tick. The HTTP transport sends its accumulated batch here; MQTT resolves immediately. */
    flushTick(): Promise<void>
    onCommand(handler: (botId: string, command: BotCommand) => Promise<CommandOutcome>): void
}
