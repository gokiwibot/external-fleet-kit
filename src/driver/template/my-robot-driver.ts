/**
 * Template for YOUR driver. Copy to `src/driver/my-robot-driver.ts`, replace every `TODO` with a
 * call into your fleet API, and in `efk.config.ts` set `driver: (botId) => new MyRobotDriver(botId)`.
 *
 * Rules the kit relies on:
 *  - `snapshot()` must be cheap; it is called four times a second.
 *  - After you return `accepted`, emit `commandState(id, 'executing')` when the robot starts, and
 *    `arrived(id)` (navigation) or `commandState(id, 'succeeded' | 'failed')` when it finishes.
 *  - Never emit for an id you did not accept. The kit ignores it and logs a warning.
 *  - If you return `rejected`, use one of the four contract codes; anything else must be a throw.
 */
import type { DestinationValidation } from '../../contract/schemas'
import {
    type DriverAccept,
    type DriverContext,
    type DriverEvents,
    type DriverSnapshot,
    defaultValidateDestination,
    type Position,
    type RobotDriver,
} from '../robot-driver'

export class MyRobotDriver implements RobotDriver {
    readonly driverVersion = 1 as const
    private handlers = new Map<keyof DriverEvents, Set<(...args: never[]) => void>>()
    private ctx: DriverContext | null = null

    constructor(readonly botId: string) {}

    async start(ctx: DriverContext): Promise<void> {
        this.ctx = ctx
        // TODO: open your connection to the robot (websocket, polling loop, ROS bridge…).
        // When the robot reports progress, call this.emit('commandState', id, 'executing') etc.
    }

    async stop(): Promise<void> {
        // TODO: close it.
    }

    snapshot(): DriverSnapshot {
        // TODO: read from your latest telemetry. Return position: null if you do not know where the robot is.
        return { position: null, batteryPercentage: 100, door: 'unsupported', available: false, connected: false }
    }

    capabilities() {
        // TODO: declare only what the robot really does. remi never infers a capability.
        return {
            hasDoor: false,
            supportedCommands: ['navigate_to', 'cancel_navigation'] as Array<'navigate_to' | 'cancel_navigation' | 'set_door'>,
        }
    }

    async navigateTo(cmd: { id: string; target: Position; expiresAt?: number }): Promise<DriverAccept> {
        // TODO: send the goal. If your API moves the destination onto its drivable network, return
        // { kind: 'accepted_with_correction', position, distanceM }. If it cannot reach it, return
        // { kind: 'rejected', code: 'DESTINATION_UNREACHABLE', message, correctionDistanceM }.
        // If a navigation is running and your API cannot replace it, return { kind: 'rejected', code: 'BOT_BUSY', message }
        // and set fleet.supportsCommandInterrupt to false in efk.config.ts.
        this.ctx?.log('navigateTo not implemented', { id: cmd.id })
        return { kind: 'rejected', code: 'UNSUPPORTED_COMMAND', message: 'MyRobotDriver.navigateTo is not implemented yet' }
    }

    async cancelNavigation(cmd: { id: string }): Promise<DriverAccept> {
        // TODO: stop the robot where it stands, then emit commandState(cmd.id, 'succeeded').
        this.ctx?.log('cancelNavigation not implemented', { id: cmd.id })
        return { kind: 'accepted' }
    }

    async setDoor(cmd: { id: string; state: 'open' | 'closed' }): Promise<DriverAccept> {
        // TODO: actuate the door; make snapshot().door report the result (`opened`/`closed`) and emit stateChanged().
        this.ctx?.log('setDoor not implemented', { id: cmd.id, state: cmd.state })
        return { kind: 'rejected', code: 'UNSUPPORTED_COMMAND', message: 'this robot has no door' }
    }

    validateDestination(position: Position): Promise<DestinationValidation> {
        // Keep the default if your robots do not correct destinations; otherwise apply the same
        // correction navigateTo applies, and make sure the same coordinate always gets the same answer.
        return defaultValidateDestination(position)
    }

    on<K extends keyof DriverEvents>(event: K, handler: DriverEvents[K]): () => void {
        const set = this.handlers.get(event) ?? new Set()
        set.add(handler as (...args: never[]) => void)
        this.handlers.set(event, set)
        return () => set.delete(handler as (...args: never[]) => void)
    }

    protected emit<K extends keyof DriverEvents>(event: K, ...args: Parameters<DriverEvents[K]>): void {
        for (const handler of this.handlers.get(event) ?? []) (handler as (...a: Parameters<DriverEvents[K]>) => void)(...args)
    }
}
