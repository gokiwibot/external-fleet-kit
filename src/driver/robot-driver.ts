/**
 * The seam a partner implements: everything the kit needs from a robot, and nothing about the
 * contract. The kit owns idempotency, expiry, capability checks, `seq`, the timestamp and the zod
 * validation (see `BotRuntime`); a driver only drives, reports what it sees, and answers whether it
 * took a command.
 *
 * Task 9 owns this interface — it adds the partner-facing template and its documentation on top of
 * the same declarations. It is written here because `BotRuntime` imports it as a type and cannot
 * compile without it.
 *
 * `driverVersion` is the number the kit checks when it learns to expect more from a driver than a
 * partner's copy provides; it stays `1` for the whole `2026-09` contract.
 */
import type { CommandType, DestinationValidation, DoorState, RejectionCode } from '../contract/schemas'

/** A WGS84 point. Structurally the contract's `BotPosition`, restated so a driver need not import the contract. */
export type Position = { lat: number; lng: number }

/** What the kit lends the driver at `start()`: its clock and its log, never ambient ones. */
export type DriverContext = {
    now(): number
    log(message: string, data?: Record<string, unknown>): void
}

/**
 * Everything the kit reads off a robot to build a BotState. `position: null` means the driver does
 * not know where the robot is — the kit drops the state rather than invent a position — and
 * `speedMps` is optional because a driver that cannot measure speed must not have to fake a zero.
 */
export type DriverSnapshot = {
    position: Position | null
    batteryPercentage: number
    speedMps?: number
    door: DoorState
    available: boolean
    connected: boolean
}

/** camelCase here, snake_case on the wire: the mapping to `BotCapabilities` belongs to the kit. */
export type DriverCapabilities = { hasDoor: boolean; supportedCommands: CommandType[] }

/**
 * The driver's answer to a command. A rejection carries one of the contract's four codes, because a
 * rejection is the one driver outcome that reaches remi verbatim; anything else the driver wants to
 * say about a failure it says later, through `commandState(id, 'failed', error)`.
 */
export type DriverAccept =
    | { kind: 'accepted' }
    | { kind: 'accepted_with_correction'; position: Position; distanceM: number }
    | { kind: 'rejected'; code: RejectionCode; message: string; correctionDistanceM?: number }

export type DriverEvents = {
    /** The command moved. `failed` must carry the error: the contract requires a reason on a failure. */
    commandState: (id: string, state: 'executing' | 'succeeded' | 'failed', error?: { code: string; message: string }) => void
    arrived: (commandId: string) => void
    blocked: (detail: { reason: string; message: string }) => void
    unblocked: () => void
    /** Something in the snapshot changed and the kit should publish now instead of at the next heartbeat. */
    stateChanged: () => void
}

export interface RobotDriver {
    readonly botId: string
    readonly driverVersion: 1
    start(ctx: DriverContext): Promise<void>
    stop(): Promise<void>
    snapshot(): DriverSnapshot
    capabilities(): DriverCapabilities
    navigateTo(command: { id: string; target: Position; expiresAt?: number }): Promise<DriverAccept>
    cancelNavigation(command: { id: string }): Promise<DriverAccept>
    setDoor(command: { id: string; state: 'open' | 'closed' }): Promise<DriverAccept>
    validateDestination(position: Position): Promise<DestinationValidation>
    /** Subscribe; the returned function unsubscribes. `BotRuntime.stop()` calls every one of them. */
    on<K extends keyof DriverEvents>(event: K, handler: DriverEvents[K]): () => void
}
