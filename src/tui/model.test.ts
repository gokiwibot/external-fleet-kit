import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BotCommand, CommandStatus } from '../contract/schemas'
import type { BotRuntime } from '../core/bot-runtime'
import { createEventBus, REPLAY_BUFFER_MAX } from '../core/events'
import type { FleetManager } from '../core/fleet-manager'
import type { RobotDriver } from '../driver/robot-driver'
import { createSimulatedDriver } from '../driver/simulated'
import { botScenarioSchema } from '../driver/simulated/scenario'
import {
    applyReplay,
    type BotRow,
    botRows,
    controlsFor,
    createModel,
    guardToggle,
    hhmmss,
    linkLabel,
    type ManualControls,
    manualControls,
    nextOfflinePin,
    outcomeLabel,
    pad,
    reduce,
    reportableDriverFailures,
    toggleAvailable,
} from './model'

const T0 = 1_800_000_000_000
const nav = (id: string): BotCommand => ({ id, type: 'navigate_to', params: { lat: 0, lng: 0 }, issued_at: new Date(T0).toISOString() })
const accepted = (id: string): CommandStatus => ({ id, state: 'accepted', accepted_at: new Date(T0).toISOString() })

describe('tui model', () => {
    it('groups resends of the same command id into one row and counts them', () => {
        let m = createModel()
        m = reduce(m, 'command.received', { botId: 'ACME-0001', command: nav('J/pickup'), via: 'mqtt', receivedAt: T0 }, T0)
        m = reduce(
            m,
            'command.received',
            { botId: 'ACME-0001', command: nav('J/pickup'), via: 'mqtt', receivedAt: T0 + 10_000 },
            T0 + 10_000,
        )
        m = reduce(
            m,
            'command.received',
            { botId: 'ACME-0001', command: nav('J/pickup'), via: 'mqtt', receivedAt: T0 + 20_000 },
            T0 + 20_000,
        )
        assert.equal(m.commands.length, 1)
        assert.equal(m.commands[0]?.sends, 3)
        assert.equal(m.commands[0]?.lastAt, T0 + 20_000)
    })
    it('records the synchronous outcome and the echo latency on the same row', () => {
        let m = createModel()
        m = reduce(m, 'command.received', { botId: 'ACME-0001', command: nav('J/pickup'), via: 'http', receivedAt: T0 }, T0)
        m = reduce(
            m,
            'command.outcome',
            { botId: 'ACME-0001', commandId: 'J/pickup', outcome: { kind: 'accepted', status: accepted('J/pickup') }, latencyMs: 12 },
            T0 + 12,
        )
        m = reduce(m, 'command.echoed', { botId: 'ACME-0001', commandId: 'J/pickup', echoLatencyMs: 730 }, T0 + 730)
        assert.equal(m.commands[0]?.outcome, '202 accepted')
        assert.equal(m.commands[0]?.echoLatencyMs, 730)
    })
    it('keeps commands, events and log newest-first and bounded', () => {
        let m = createModel({ maxRows: 3 })
        for (let i = 0; i < 5; i += 1) {
            m = reduce(m, 'command.received', { botId: 'ACME-0001', command: nav(`J/${i}`), via: 'mqtt', receivedAt: T0 + i }, T0 + i)
            m = reduce(m, 'log', { level: 'info', message: `line ${i}` }, T0 + i)
        }
        assert.deepEqual(
            m.commands.map((c) => c.commandId),
            ['J/4', 'J/3', 'J/2'],
        )
        assert.deepEqual(
            m.log.map((l) => l.message),
            ['line 4', 'line 3', 'line 2'],
        )
    })
    it('a dropped state becomes a red log line and bumps the per-bot drop counter', () => {
        let m = createModel()
        m = reduce(m, 'state.dropped', { botId: 'ACME-0001', reason: 'position is null' }, T0)
        assert.equal(m.log[0]?.dropped, true)
        assert.match(m.log[0]?.message ?? '', /position is null/)
        assert.equal(m.dropped['ACME-0001'], 1)
    })
    it('labels outcomes by transport: HTTP shows the status code, MQTT shows the state word', () => {
        assert.equal(outcomeLabel({ kind: 'rejected', code: 'BOT_BUSY', message: 'busy' }, 'http'), '409 BOT_BUSY')
        assert.equal(outcomeLabel({ kind: 'rejected', code: 'UNSUPPORTED_COMMAND', message: '' }, 'http'), '422 UNSUPPORTED_COMMAND')
        assert.equal(
            outcomeLabel({ kind: 'rejected', code: 'DESTINATION_UNREACHABLE', message: '' }, 'mqtt'),
            'rejected DESTINATION_UNREACHABLE',
        )
        assert.equal(outcomeLabel({ kind: 'driver_error', message: 'boom' }, 'http'), '503 DRIVER_ERROR')
        assert.equal(outcomeLabel({ kind: 'driver_error', message: 'boom' }, 'mqtt'), 'no response (DRIVER_ERROR)')
        assert.equal(outcomeLabel({ kind: 'duplicate', status: accepted('J/x') }, 'http'), '202 duplicate')
    })
})

describe('tui model, formatting', () => {
    it('prints a clock for a real timestamp and a gap for one that is not a time', () => {
        assert.equal(hhmmss(T0), '08:00:00')
        assert.equal(hhmmss(Number.NaN), '--:--:--')
    })
    it('pads, truncates, and survives a cell that is not a string', () => {
        assert.equal(pad('ACME-0001', 12), 'ACME-0001   ')
        assert.equal(pad('ACME-0001', 4), 'ACME')
        assert.equal(pad(undefined, 3), '   ')
        assert.equal(pad(7 as unknown as string, 3), '7  ')
    })
})

describe('tui model, a malformed event cannot take the fleet down', () => {
    it('turns an unreadable payload into one red log line and keeps everything already folded', () => {
        let m = createModel()
        m = reduce(m, 'command.received', { botId: 'ACME-0001', command: nav('J/pickup'), via: 'mqtt', receivedAt: T0 }, T0)
        // `command` is missing entirely: reading `p.command.id` throws inside the fold.
        m = reduce(m, 'command.received', { botId: 'ACME-0001', via: 'mqtt', receivedAt: T0 } as never, T0 + 1)
        // The row that WAS readable is still there — without this the same test passes on a reducer
        // that quietly returns an empty model.
        assert.equal(m.commands.length, 1)
        assert.equal(m.commands[0]?.commandId, 'J/pickup')
        assert.equal(m.log.length, 1)
        assert.equal(m.log[0]?.level, 'error')
        assert.match(m.log[0]?.message ?? '', /could not read a 'command\.received' event/)
    })
    it('renders a label for an outcome whose kind it has never heard of, instead of undefined', () => {
        assert.equal(outcomeLabel({ kind: 'accepted', status: accepted('J/x') }, 'mqtt'), 'accepted')
        assert.equal(outcomeLabel({ kind: 'exploded' } as never, 'http'), 'unknown outcome')
    })
})

describe('tui model, debt 1: the events fired before the screen existed', () => {
    it('replays what the bus buffered before anyone subscribed, keeping the time each was emitted', () => {
        const clock = { t: T0 }
        const bus = createEventBus({ now: () => clock.t })
        bus.emit('log', { level: 'info', message: 'fleet started' })
        clock.t += 1_000
        bus.emit('link.changed', { botId: 'ACME-0001', connected: false, reason: 'offline' })

        const m = applyReplay(createModel(), bus.replay(), T0 + 9_999)
        assert.deepEqual(
            m.log.map((l) => l.message),
            ['ACME-0001 disconnected (offline)', 'fleet started'],
        )
        assert.deepEqual(
            m.log.map((l) => l.at),
            [T0 + 1_000, T0],
        )
    })
    it('keeps the OLDEST events when the buffer fills and says how many are missing', () => {
        const bus = createEventBus({ now: () => T0 })
        for (let i = 0; i < REPLAY_BUFFER_MAX + 3; i += 1) bus.emit('log', { level: 'info', message: `line ${i}` })
        const replay = bus.replay()
        assert.equal(replay.events.length, REPLAY_BUFFER_MAX)
        assert.equal(replay.dropped, 3)

        const m = applyReplay(createModel({ maxRows: REPLAY_BUFFER_MAX + 1 }), replay, T0)
        // The first event of the run survived, the marker sits on top of it, and the three events
        // past the bound are accounted for rather than silently absent.
        assert.equal(m.log.at(-1)?.message, 'line 0')
        assert.equal(m.log[0]?.level, 'warn')
        assert.match(m.log[0]?.message ?? '', /3 events between the lines below and this one were not kept/)
    })
    it('drains nothing, so a second observer catches up too', () => {
        const bus = createEventBus({ now: () => T0 })
        bus.emit('log', { level: 'info', message: 'fleet started' })
        assert.equal(bus.replay().events.length, 1)
        assert.equal(bus.replay().events.length, 1)
    })
})

/** A real simulated driver, which is the only driver these toggles are for. */
function simulatedDriver(over: Record<string, unknown> = {}) {
    const scenario = botScenarioSchema.parse(over)
    return createSimulatedDriver({
        botId: 'ACME-0001',
        scenario,
        origin: { lat: 0, lng: 0 },
        scatterRadiusM: 0,
        now: () => T0,
        random: () => 0.5,
    })
}

describe('tui model, debt 2: the offline toggle can hand the bot back to its scenario', () => {
    it('cycles scenario → pinned down → pinned up → scenario', () => {
        assert.equal(nextOfflinePin(undefined), true)
        assert.equal(nextOfflinePin(null), true)
        assert.equal(nextOfflinePin(true), false)
        assert.equal(nextOfflinePin(false), null)
    })
    it('a pinned link and a scenario-driven one read differently in the link column', () => {
        assert.equal(linkLabel(true, null), 'up')
        assert.equal(linkLabel(true, false), 'up*')
        assert.equal(linkLabel(false, true), 'down*')
        assert.equal(linkLabel(false, undefined), 'down')
    })
    it('a full cycle of `o` leaves the driver back under its scenario, not pinned online', async () => {
        const driver = simulatedDriver({ link: { mode: 'offline' } })
        await driver.start({ now: () => T0, log: () => {} })
        const controls = manualControls(driver)
        assert.notEqual(controls, null)
        if (!controls) return
        assert.equal(driver.snapshot().connected, false)

        let pin = nextOfflinePin(undefined)
        controls.setOffline(pin)
        assert.equal(driver.snapshot().connected, false)
        pin = nextOfflinePin(pin)
        controls.setOffline(pin)
        assert.equal(driver.snapshot().connected, true)
        pin = nextOfflinePin(pin)
        assert.equal(pin, null)
        controls.setOffline(pin)
        // Back to what the scenario says — an `offline` link, not the `up` the last press pinned.
        assert.equal(driver.snapshot().connected, false)
    })
})

describe('tui model, debt 3: the availability toggle on a flat battery', () => {
    it('says the toggle did not take, and names the battery, instead of looking dead', async () => {
        const driver = simulatedDriver({ battery: { startPct: 10, unavailableBelowPct: 20 }, available: false })
        await driver.start({ now: () => T0, log: () => {} })
        const controls = manualControls(driver)
        assert.notEqual(controls, null)
        if (!controls) return
        const touched: number[] = []
        const bot = { botId: 'ACME-0001', snapshot: () => driver.snapshot(), touch: () => touched.push(1) }
        assert.equal(driver.snapshot().available, false)

        const result = toggleAvailable(controls, bot)
        assert.equal(result.requested, true)
        assert.equal(result.applied, false)
        assert.equal(touched.length, 1)
        assert.match(result.note ?? '', /had no effect on ACME-0001/)
        assert.match(result.note ?? '', /10% battery/)
    })
    it('says nothing when the toggle does take, and the bot really changes', async () => {
        const driver = simulatedDriver({ available: true })
        await driver.start({ now: () => T0, log: () => {} })
        const controls = manualControls(driver)
        assert.notEqual(controls, null)
        if (!controls) return
        const bot = { botId: 'ACME-0001', snapshot: () => driver.snapshot(), touch: () => {} }

        const result = toggleAvailable(controls, bot)
        assert.equal(result.requested, false)
        assert.equal(result.applied, true)
        assert.equal(result.note, null)
        assert.equal(driver.snapshot().available, false)
    })
})

describe('tui model, manual controls', () => {
    it('are found on the simulated driver and refused on a driver that has none', () => {
        assert.notEqual(manualControls(simulatedDriver()), null)
        assert.equal(manualControls(undefined), null)
        const bare = { botId: 'ACME-0001', driverVersion: 1 as const }
        assert.equal(manualControls(bare as never), null)
    })
})

/**
 * A fleet of hand-built runtimes, because the property under test is what the TUI does with a
 * `RobotDriver` the partner wrote — including one that throws, which the bundled simulator never does.
 */
function managerOf(runtimes: Array<Partial<BotRuntime> & { botId: string }>, drivers: Record<string, RobotDriver> = {}): FleetManager {
    return {
        bots: () => runtimes as BotRuntime[],
        driver: (botId: string) => drivers[botId],
    } as unknown as FleetManager
}

function healthyRuntime(botId: string): Partial<BotRuntime> & { botId: string } {
    return {
        botId,
        snapshot: () => ({ position: { lat: 0, lng: 0 }, batteryPercentage: 87, door: 'closed', available: true, connected: true }),
        currentCommand: () => null,
        dropped: () => 0,
    }
}

describe('tui model, a driver that throws cannot take the screen down', () => {
    it('degrades only the row whose driver threw, and names the call that did it', () => {
        const boom = {
            ...healthyRuntime('ACME-0002'),
            snapshot: () => {
                throw new TypeError('the robot API is not reachable')
            },
        }
        const rows = botRows(managerOf([healthyRuntime('ACME-0001'), boom, healthyRuntime('ACME-0003')]), createModel(), T0)

        assert.equal(rows.length, 3)
        // The property that matters: the healthy bots still render, with their real readings.
        assert.equal(rows[0]?.driverError, null)
        assert.equal(rows[0]?.batteryPercentage, 87)
        assert.equal(rows[2]?.driverError, null)
        assert.equal(rows[2]?.connected, true)
        // And the failing one is legible instead of absent or half-built.
        assert.equal(rows[1]?.botId, 'ACME-0002')
        assert.equal(rows[1]?.command, 'driver error')
        assert.match(rows[1]?.driverError ?? '', /^snapshot\(\) threw: /)
        // `describeThrown` quotes no message, so nothing the driver was holding reaches the screen.
        assert.equal(rows[1]?.driverError?.includes('the robot API is not reachable'), false)
    })
    it('names `dropped` when that is the call that threw', () => {
        const boom = {
            ...healthyRuntime('ACME-0001'),
            dropped: () => {
                throw new Error('nope')
            },
        }
        const rows = botRows(managerOf([boom]), createModel(), T0)
        assert.match(rows[0]?.driverError ?? '', /^dropped\(\) threw: /)
    })
    it('keeps the age and the seq the kit recorded itself, which the driver cannot invalidate', () => {
        let model = createModel()
        model = reduce(model, 'state.published', { botId: 'ACME-0001', state: { seq: 41 } as never, transport: 'mqtt' }, T0)
        const boom = {
            ...healthyRuntime('ACME-0001'),
            snapshot: () => {
                throw new Error('nope')
            },
        }
        const rows = botRows(managerOf([boom]), model, T0 + 5_000)
        assert.equal(rows[0]?.seq, 41)
        assert.equal(rows[0]?.lastPublishedAgeMs, 5_000)
    })
    it('reports a failing driver once, not twice a second, and again only after it has recovered', () => {
        const reported = new Set<string>()
        const failing: BotRow[] = [
            { ...blankRow('ACME-0001'), driverError: 'snapshot() threw: Error, with no code this kit can safely quote' },
            blankRow('ACME-0002'),
        ]
        const first = reportableDriverFailures(failing, reported)
        assert.equal(first.length, 1)
        assert.equal(first[0]?.botId, 'ACME-0001')
        assert.match(first[0]?.message ?? '', /reading its driver failed/)
        // Same failure on the next tick: nothing new to say.
        assert.deepEqual(reportableDriverFailures(failing, reported), [])
        // It recovers...
        assert.deepEqual(reportableDriverFailures([blankRow('ACME-0001'), blankRow('ACME-0002')], reported), [])
        // ...and fails again, which IS news.
        assert.equal(reportableDriverFailures(failing, reported).length, 1)
    })
})

function blankRow(botId: string): BotRow {
    return {
        botId,
        connected: true,
        available: true,
        batteryPercentage: 100,
        door: 'closed',
        command: '—',
        lastPublishedAgeMs: null,
        seq: null,
        dropped: 0,
        driverError: null,
    }
}

describe('tui model, a driver that throws cannot take the keyboard down', () => {
    /**
     * Five controls that all throw, each with a message distinctive enough that finding it on screen
     * could not be a coincidence: a driver's exception may quote anything it was holding.
     */
    const LEAK = 'live_sk_this_must_never_be_printed'
    const hostileControls = (): ManualControls => {
        const boom = () => {
            throw new Error(LEAK)
        }
        return { setAvailable: boom, toggleDoorLocally: boom, setOffline: boom, emitBlocked: boom, emitUnblocked: boom }
    }

    it('runs the action and says nothing when it works', () => {
        const calls: string[] = []
        assert.equal(
            guardToggle('ACME-0001', () => calls.push('setOffline')),
            null,
        )
        assert.deepEqual(calls, ['setOffline'])
    })
    it('turns a control that throws into a note naming the bot, and does not rethrow', () => {
        const controls = manualControls(hostileControls() as unknown as RobotDriver)
        assert.notEqual(controls, null)
        if (!controls) return
        for (const press of [
            () => controls.setOffline(null),
            () => controls.toggleDoorLocally(),
            () => controls.emitBlocked('operator_test'),
        ]) {
            const note = guardToggle('ACME-0001', press)
            // Positive first — a stub that returned an empty string would pass the check below alone.
            assert.match(note ?? '', /^ACME-0001 refused that key: /)
            assert.equal(note?.includes(LEAK), false)
        }
    })
    it('answers no controls for a driver whose own properties throw, instead of throwing in the render body', () => {
        const hostile = { botId: 'ACME-0001', driverVersion: 1 }
        Object.defineProperty(hostile, 'setAvailable', {
            get() {
                throw new Error('property access is not safe here')
            },
        })
        assert.equal(manualControls(hostile as unknown as RobotDriver), null)
        assert.equal(controlsFor(managerOf([], { 'ACME-0001': hostile as unknown as RobotDriver }), 'ACME-0001'), null)
    })
    it('answers no controls when the driver lookup itself throws', () => {
        const manager = {
            bots: () => [],
            driver: () => {
                throw new Error('the fleet is gone')
            },
        } as unknown as FleetManager
        assert.equal(controlsFor(manager, 'ACME-0001'), null)
        assert.equal(controlsFor(manager, undefined), null)
    })
})
