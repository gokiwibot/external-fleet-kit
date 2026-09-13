/**
 * RobotDriver v1 — the boundary of the kit (design §5).
 *
 * Above this interface (idempotency, seq, cadence, validation, transport, TUI) is the kit's job.
 * Below it (how a robot moves, how its door opens, what its battery says) is the driver's job.
 * The driver never sees a BotState, a topic or an HTTP status.
 *
 * To connect your robots: copy `template/my-robot-driver.ts`, implement the methods against your
 * API, and point `efk.config.ts` at it. Nothing else in the kit changes.
 */
import type { DestinationValidation, DoorState, RejectionCode } from '../contract/schemas'

export type { DoorState }

/** WGS 84, the only frame remi understands (BotPosition on the page). */
export type Position = Readonly<{ lat: number; lng: number }>

/** What the driver knows about its robot right now. The kit reads it on every tick and on every change. */
export interface DriverSnapshot {
    /** null = the robot does not know where it is; the kit publishes no state without a position. */
    position: Position | null
    /** 0-100. The kit rounds to an integer. */
    batteryPercentage: number
    /** Optional in the contract; omit if unknown. */
    speedMps?: number
    /** Only `opened` and `closed` are mandatory for a driver with a door; `unsupported` if there is no door. */
    door: DoorState
    /** "Can take work": the partner's throttle. */
    available: boolean
    /** "I have a link to the robot". The broker outranks it in MQTT mode, but the field is required. */
    connected: boolean
}

/**
 * Synchronous answer to a command. `accepted*` obliges the driver to emit `commandState` later.
 * A THROW is not a DriverAccept: the kit catches it and treats it as DRIVER_ERROR (503 in HTTP;
 * in MQTT current_command is left untouched so remi resends).
 */
export type DriverAccept =
    | { kind: 'accepted' }
    | { kind: 'accepted_with_correction'; position: Position; distanceM: number }
    | { kind: 'rejected'; code: RejectionCode; message: string; correctionDistanceM?: number }

export type CommandTerminal = 'succeeded' | 'failed'

export interface DriverEvents {
    /** Command `id` changed phase. The kit mirrors it into current_command. Terminal states never move back. */
    commandState: (id: string, state: 'executing' | CommandTerminal, error?: { code: string; message: string }) => void
    /** Arrival at the destination of navigation `id`. The kit marks it succeeded and emits the `arrived` event. */
    arrived: (id: string) => void
    /** The robot needs a person. Optional in the contract. */
    blocked: (detail: { reason: string; message: string }) => void
    unblocked: () => void
    /** Something in the snapshot changed and deserves publishing before the next tick (door, available, connected). */
    stateChanged: () => void
}

/** What the kit lends the driver at `start()`: its clock and its log, never ambient ones. */
export type DriverContext = { now(): number; log(message: string, data?: Record<string, unknown>): void }

export interface RobotDriver {
    /** The bot_id as remi registered it; the kit only instantiates drivers for ids in the roster. */
    readonly botId: string
    /** Interface version. The kit refuses to start a driver with a different value. */
    readonly driverVersion: 1

    start(ctx: DriverContext): Promise<void>
    stop(): Promise<void>

    snapshot(): DriverSnapshot
    capabilities(): { hasDoor: boolean; supportedCommands: Array<'navigate_to' | 'cancel_navigation' | 'set_door'> }

    /** Go to a point. With a navigation in progress: accept and replace it if the fleet declares supports_command_interrupt. */
    navigateTo(cmd: { id: string; target: Position; expiresAt?: number }): Promise<DriverAccept>
    cancelNavigation(cmd: { id: string }): Promise<DriverAccept>
    /** The command carries the verb (`open`/`closed`); the snapshot reports the result (`opened`/`closed`). */
    setDoor(cmd: { id: string; state: 'open' | 'closed' }): Promise<DriverAccept>

    /**
     * POST /destinations/validate of the contract (required in HTTP mode). Read-only and idempotent:
     * the same coordinate must return the same answer. Use `defaultValidateDestination` if your
     * robots do not correct destinations.
     */
    validateDestination(position: Position): Promise<DestinationValidation>

    /** Subscribe; the returned function unsubscribes. `BotRuntime.stop()` calls every one of them. */
    on<K extends keyof DriverEvents>(event: K, handler: DriverEvents[K]): () => void
}

/** What the contract asks a partner to return when a point is reachable as-is (correction_distance_m: 0). */
export async function defaultValidateDestination(position: Position): Promise<DestinationValidation> {
    return { reachable: true, corrected_position: position, correction_distance_m: 0 }
}

/**
 * What `efk.config.ts` assigns to `driver`: builds one `RobotDriver` per bot id the kit discovered
 * on the roster. `env.origin` is the fleet's home point (from `SANDBOX_CENTER_LAT`/`SANDBOX_CENTER_LNG`)
 * — the simulated driver spawns new bots there; a real driver may ignore it.
 *
 * Declared here, and only here (controller ruling R12): the simulated driver and the CLI config
 * loader both need it, the simulated driver's own module runs before the config loader exists, and
 * `robot-driver.ts` depends on nothing, so it is already loadable by both.
 *
 * `auditRoster` is optional and read-only: given the roster the kit resolved, it returns the ids
 * that look wrong for this driver (for example, a scenario override that names a bot outside the
 * roster). `efk check` surfaces whatever it returns as a warning; returning nothing means "nothing
 * to flag".
 */
export type DriverFactory = ((botId: string, env: { origin: Position }) => RobotDriver) & {
    auditRoster?: (roster: string[]) => string[]
}
