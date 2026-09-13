/** Test doubles shared by the core tests. They are not part of the package's public surface (`src/index.ts` does not re-export them), but they are ordinary modules and `efk start --demo` imports the fake remi client that lives next to them (`fake-remi.ts`, Task 7). */
import type { BotCapabilities } from '../contract/schemas'
import type { DriverAccept, DriverEvents, DriverSnapshot, RobotDriver } from '../driver/robot-driver'

export class FakeDriver implements RobotDriver {
    readonly driverVersion = 1 as const
    calls: Array<{ method: string; id: string }> = []
    accept: DriverAccept = { kind: 'accepted' }
    throwOnNext = false
    snap: DriverSnapshot = {
        position: { lat: 33.97, lng: -118.41 },
        batteryPercentage: 80,
        speedMps: 0,
        door: 'closed',
        available: true,
        connected: true,
    }
    caps: BotCapabilities = { has_door: true, supported_commands: ['navigate_to', 'cancel_navigation', 'set_door'] }
    private handlers = new Map<keyof DriverEvents, Set<(...args: never[]) => void>>()

    constructor(readonly botId: string) {}
    async start() {}
    async stop() {}
    snapshot() {
        return this.snap
    }
    capabilities() {
        return { hasDoor: this.caps.has_door, supportedCommands: this.caps.supported_commands }
    }
    private answer(method: string, id: string): Promise<DriverAccept> {
        this.calls.push({ method, id })
        if (this.throwOnNext) {
            this.throwOnNext = false
            throw new Error('boom')
        }
        return Promise.resolve(this.accept)
    }
    navigateTo(cmd: { id: string }) {
        return this.answer('navigateTo', cmd.id)
    }
    cancelNavigation(cmd: { id: string }) {
        return this.answer('cancelNavigation', cmd.id)
    }
    setDoor(cmd: { id: string }) {
        return this.answer('setDoor', cmd.id)
    }
    async validateDestination(position: { lat: number; lng: number }) {
        return { reachable: true as const, corrected_position: position, correction_distance_m: 0 }
    }
    on<K extends keyof DriverEvents>(event: K, handler: DriverEvents[K]) {
        const set = this.handlers.get(event) ?? new Set()
        set.add(handler as (...args: never[]) => void)
        this.handlers.set(event, set)
        return () => set.delete(handler as (...args: never[]) => void)
    }
    /** Test helper: fire a driver event. */
    fire<K extends keyof DriverEvents>(event: K, ...args: Parameters<DriverEvents[K]>) {
        for (const handler of this.handlers.get(event) ?? []) (handler as (...a: Parameters<DriverEvents[K]>) => void)(...args)
    }
}

export class FakeClock {
    constructor(public nowMs = 1_800_000_000_000) {}
    now = () => this.nowMs
    advance(ms: number) {
        this.nowMs += ms
    }
}
