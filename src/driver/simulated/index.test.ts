import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createSimulatedDriver, listScenarios, SCENARIO_NOTES, scenarioPath, simulated } from './index'
import { metersBetween, NEVER_ARRIVE_GAP_M, STALL_FRACTION } from './motion'
import { botScenarioFor, botScenarioSchema, parseScenario } from './scenario'

const T0 = 1_800_000_000_000
const origin = { lat: 0, lng: 0 }
const fixed = (v: number) => () => v
const quiet = { noise: { lateralM: 0, speedJitter: 0, stopRatePerKm: 0, headingNoiseDeg: 0 } }

/** A tiny deterministic PRNG (mulberry32), so "same seed, same trace" is a real claim. */
function seeded(seed: number): () => number {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function driver(over: Record<string, unknown> = {}, nowRef = { t: T0 }) {
    const scenario = botScenarioSchema.parse({ motion: quiet, ...over })
    return createSimulatedDriver({ botId: 'ACME-0001', scenario, origin, scatterRadiusM: 0, now: () => nowRef.t, random: fixed(0.5) })
}

describe('simulated driver', () => {
    it('starts at the origin, idle, connected, available, full battery, door closed', async () => {
        const d = driver()
        await d.start({ now: () => T0, log: () => {} })
        const s = d.snapshot()
        assert.deepEqual(s.position, origin)
        assert.equal(s.available, true)
        assert.equal(s.connected, true)
        assert.equal(s.batteryPercentage, 100)
        assert.equal(s.door, 'closed')
        assert.equal(s.speedMps, 0)
    })
    it('navigates at 1.5 m/s, emits executing then arrived, and the door opens on set_door', async () => {
        const now = { t: T0 }
        const d = driver({}, now)
        await d.start({ now: () => now.t, log: () => {} })
        // One listener per command id: a shared list turns "did the nav succeed" and "did the door
        // succeed" into the same assertion and hides which one actually fired.
        const navStates: string[] = []
        const doorStates: string[] = []
        d.on('commandState', (id, state) => (id === 'J/pickup' ? navStates : doorStates).push(state))
        const arrived: string[] = []
        d.on('arrived', (id) => arrived.push(id))
        const accept = await d.navigateTo({ id: 'J/pickup', target: { lat: 0.0001, lng: 0 } }) // ≈ 11 m
        assert.deepEqual(accept, { kind: 'accepted' })
        now.t += 250
        d.tick(now.t)
        assert.deepEqual(navStates, ['executing'])
        assert.ok((d.snapshot().speedMps ?? 0) > 1.4)
        for (let i = 0; i < 40; i += 1) {
            now.t += 250
            d.tick(now.t)
        }
        assert.deepEqual(arrived, ['J/pickup'])
        assert.deepEqual(navStates, ['executing', 'succeeded'])
        assert.ok(metersBetween(d.snapshot().position ?? origin, { lat: 0.0001, lng: 0 }) < 0.01)
        assert.equal(d.snapshot().speedMps, 0)

        assert.deepEqual(await d.setDoor({ id: 'J/door', state: 'open' }), { kind: 'accepted' })
        now.t += 250
        d.tick(now.t)
        assert.equal(d.snapshot().door, 'opening')
        assert.deepEqual(doorStates, [], 'the lid is still moving')
        now.t += 2_000
        d.tick(now.t)
        assert.equal(d.snapshot().door, 'opened')
        assert.deepEqual(doorStates, ['succeeded'])
    })
    it('set_door for the state the lid is already in succeeds on the next tick instead of hanging', async () => {
        const now = { t: T0 }
        const d = driver({}, now)
        await d.start({ now: () => now.t, log: () => {} })
        assert.equal(d.snapshot().door, 'closed')
        const states: string[] = []
        d.on('commandState', (id, state) => {
            if (id === 'J/close') states.push(state)
        })
        assert.deepEqual(await d.setDoor({ id: 'J/close', state: 'closed' }), { kind: 'accepted' })
        now.t += 250
        d.tick(now.t)
        assert.deepEqual(
            states,
            ['succeeded'],
            'remi closes the door at the end of every delivery; this is the commonest set_door there is',
        )
        assert.equal(d.snapshot().door, 'closed')
    })
    it('door mode ignore is the fault: the command is accepted and never answered', async () => {
        const now = { t: T0 }
        const d = driver({ door: { mode: 'ignore' } }, now)
        await d.start({ now: () => now.t, log: () => {} })
        let answers = 0
        d.on('commandState', () => answers++)
        await d.setDoor({ id: 'J/door', state: 'open' })
        for (let i = 0; i < 20; i += 1) {
            now.t += 250
            d.tick(now.t)
        }
        assert.equal(answers, 0)
    })
    it('door mode stalled fails the command with DOOR_STALLED and reports the lid stuck', async () => {
        const now = { t: T0 }
        const d = driver({ door: { mode: 'stalled' } }, now)
        await d.start({ now: () => now.t, log: () => {} })
        const answers: Array<[string, string | undefined]> = []
        d.on('commandState', (_id, state, error) => answers.push([state, error?.code]))
        await d.setDoor({ id: 'J/door', state: 'open' })
        for (let i = 0; i < 20; i += 1) {
            now.t += 250
            d.tick(now.t)
        }
        assert.deepEqual(answers, [['failed', 'DOOR_STALLED']], 'one terminal, not one per tick')
        assert.equal(d.snapshot().door, 'stalled')
    })
    it('a second navigate_to replaces the first; cancel stops the bot and succeeds once', async () => {
        const now = { t: T0 }
        const d = driver({}, now)
        await d.start({ now: () => now.t, log: () => {} })
        await d.navigateTo({ id: 'J/a', target: { lat: 0.01, lng: 0 } })
        now.t += 250
        d.tick(now.t)
        assert.deepEqual(await d.navigateTo({ id: 'J/b', target: { lat: 0, lng: 0.01 } }), { kind: 'accepted' })
        const cancelStates: string[] = []
        d.on('commandState', (id, state) => {
            if (id === 'J/cancel') cancelStates.push(state)
        })
        assert.deepEqual(await d.cancelNavigation({ id: 'J/cancel' }), { kind: 'accepted' })
        now.t += 250
        d.tick(now.t)
        assert.deepEqual(cancelStates, ['succeeded'], 'one event: the robot has stopped')
        assert.equal(d.snapshot().speedMps, 0)
    })
    it('ackGoals: false silences the navigation echo ONLY; door and cancel still answer', async () => {
        const now = { t: T0 }
        const d = driver({ motion: { ...quiet, ackGoals: false } }, now)
        await d.start({ now: () => now.t, log: () => {} })
        const navEvents: string[] = []
        const otherEvents: Array<[string, string]> = []
        d.on('commandState', (id, state) => (id === 'J/a' ? navEvents.push(state) : otherEvents.push([id, state])))
        d.on('arrived', (id) => navEvents.push(`arrived:${id}`))
        await d.navigateTo({ id: 'J/a', target: { lat: 0.0001, lng: 0 } })
        for (let i = 0; i < 60; i += 1) {
            now.t += 250
            d.tick(now.t)
        }
        assert.deepEqual(navEvents, [], 'the lost echo: the bot drives, remi never sees the command')
        assert.ok(metersBetween(d.snapshot().position ?? origin, origin) > 10)

        await d.setDoor({ id: 'J/door', state: 'open' })
        await d.cancelNavigation({ id: 'J/cancel' })
        for (let i = 0; i < 12; i += 1) {
            now.t += 250
            d.tick(now.t)
        }
        assert.deepEqual(
            otherEvents.sort(),
            [
                ['J/cancel', 'succeeded'],
                ['J/door', 'succeeded'],
            ],
            'silencing the whole driver would be a different fault, and would make the scenario useless for a delivery',
        )
    })
    it('arrive: never parks 1 m short and stays executing; stall stops at 60 % and emits blocked', async () => {
        const now = { t: T0 }
        const never = driver({ motion: { ...quiet, arrive: 'never' } }, now)
        await never.start({ now: () => now.t, log: () => {} })
        let arrived = 0
        never.on('arrived', () => arrived++)
        await never.navigateTo({ id: 'J/a', target: { lat: 0.0001, lng: 0 } })
        for (let i = 0; i < 80; i += 1) {
            now.t += 250
            never.tick(now.t)
        }
        assert.equal(arrived, 0)
        // NEVER_ARRIVE_GAP_M and STALL_FRACTION are imported, never retyped: the numbers below are
        // the driver's promise, and a test that hard-codes 1 and 0.6 stops testing it the day
        // motion.ts moves them.
        assert.ok(Math.abs(metersBetween(never.snapshot().position ?? origin, { lat: 0.0001, lng: 0 }) - NEVER_ARRIVE_GAP_M) < 0.2)

        const stall = driver({ motion: { ...quiet, arrive: 'stall' } }, now)
        await stall.start({ now: () => now.t, log: () => {} })
        const blocked: string[] = []
        stall.on('blocked', (d) => blocked.push(d.reason))
        const goal = { lat: 0.001, lng: 0 } // ≈ 111 m
        await stall.navigateTo({ id: 'J/b', target: goal })
        for (let i = 0; i < 400; i += 1) {
            now.t += 250
            stall.tick(now.t)
        }
        assert.ok(Math.abs(metersBetween(stall.snapshot().position ?? origin, origin) - metersBetween(origin, goal) * STALL_FRACTION) < 2)
        assert.deepEqual(blocked, ['stalled'])
    })
    it('battery drains with distance and flips available below the threshold', async () => {
        const now = { t: T0 }
        const d = driver({ battery: { startPct: 21, drainPctPerKm: 100, unavailableBelowPct: 20 } }, now)
        await d.start({ now: () => now.t, log: () => {} })
        await d.navigateTo({ id: 'J/a', target: { lat: 0.0002, lng: 0 } }) // ≈ 22 m → 2.2 %
        for (let i = 0; i < 80; i += 1) {
            now.t += 250
            d.tick(now.t)
        }
        assert.equal(d.snapshot().batteryPercentage, 19)
        assert.equal(d.snapshot().available, false)
    })
    it('link offline reports connected: false and wantsConnection false; flapping alternates', async () => {
        const now = { t: T0 }
        const off = driver({ link: { mode: 'offline' } }, now)
        await off.start({ now: () => now.t, log: () => {} })
        off.tick(now.t)
        assert.equal(off.snapshot().connected, false)
        assert.equal(off.wantsConnection(), false)
        const flap = driver({ link: { mode: 'flapping', flapPeriodMs: 2_000 } }, now)
        await flap.start({ now: () => now.t, log: () => {} })
        flap.tick(now.t)
        assert.equal(flap.wantsConnection(), true)
        now.t += 1_000
        flap.tick(now.t)
        assert.equal(flap.wantsConnection(), false)
    })
    it('destination correction: snapped 202 and unreachable rejection, from the origin', async () => {
        const d = driver({ destinations: { snapGridDeg: 0.0002, unreachableBeyondM: 300 } })
        await d.start({ now: () => T0, log: () => {} })
        const ok = await d.navigateTo({ id: 'J/a', target: { lat: 0.00011, lng: 0 } })
        assert.equal(ok.kind, 'accepted_with_correction')
        assert.deepEqual(ok.kind === 'accepted_with_correction' && ok.position, { lat: 0.0002, lng: 0 })
        // A destination already ON the grid did not move, so there is no correction to report.
        const exact = await d.navigateTo({ id: 'J/on-grid', target: { lat: 0.0002, lng: 0 } })
        assert.deepEqual(exact, { kind: 'accepted' })
        const far = await d.navigateTo({ id: 'J/b', target: { lat: 1, lng: 1 } })
        assert.equal(far.kind === 'rejected' && far.code, 'DESTINATION_UNREACHABLE')
        assert.ok(far.kind === 'rejected' && (far.correctionDistanceM ?? 0) > 100_000)
        assert.equal((await d.validateDestination({ lat: 1, lng: 1 })).reachable, false)
    })
    it('validateDestination gives the same answer after the bot has MOVED', async () => {
        // The contract requires idempotency for the same coordinate, and the bot is the thing that
        // moves. Asserting `validate(x) === validate(x)` back to back proves nothing: any
        // implementation, bot-relative included, passes that. Drive the bot first.
        const now = { t: T0 }
        const d = driver({ destinations: { snapGridDeg: 0.0002, unreachableBeyondM: 300 } }, now)
        await d.start({ now: () => now.t, log: () => {} })
        const target = { lat: 0.0021, lng: 0 } // ≈ 234 m from the origin: inside the area
        const before = await d.validateDestination(target)
        await d.navigateTo({ id: 'J/move', target: { lat: 0.002, lng: 0 } })
        for (let i = 0; i < 800; i += 1) {
            now.t += 250
            d.tick(now.t)
        }
        assert.ok(metersBetween(d.snapshot().position ?? origin, origin) > 200, 'the bot really moved')
        assert.deepEqual(await d.validateDestination(target), before)
    })
    it('boolean door: never reports transients', async () => {
        const now = { t: T0 }
        const d = driver({ door: { mode: 'boolean' } }, now)
        await d.start({ now: () => now.t, log: () => {} })
        await d.setDoor({ id: 'J/d', state: 'open' })
        const seen = new Set<string>()
        for (let i = 0; i < 12; i += 1) {
            now.t += 250
            d.tick(now.t)
            seen.add(d.snapshot().door)
        }
        assert.deepEqual([...seen].sort(), ['closed', 'opened'])
    })
    it('a bot without door rejects set_door as UNSUPPORTED_COMMAND and declares no door', async () => {
        const d = driver({ door: { hasDoor: false } })
        assert.equal(d.capabilities().hasDoor, false)
        assert.deepEqual(d.capabilities().supportedCommands, ['navigate_to', 'cancel_navigation'])
        assert.equal((await d.setDoor({ id: 'x', state: 'open' })).kind, 'rejected')
    })
    it('the TUI toggles move the snapshot, and blocked/unblocked reach the listeners', async () => {
        const now = { t: T0 }
        const d = driver({}, now)
        await d.start({ now: () => now.t, log: () => {} })
        const blocked: Array<{ reason: string; message: string }> = []
        let unblocked = 0
        d.on('blocked', (detail) => blocked.push(detail))
        d.on('unblocked', () => unblocked++)
        d.setAvailable(false)
        assert.equal(d.snapshot().available, false)
        d.setOffline(true)
        assert.equal(d.snapshot().connected, false)
        assert.equal(d.wantsConnection(), false)
        d.setOffline(false)
        assert.equal(d.wantsConnection(), true, 'the toggle overrides the scenario link in both directions')
        d.toggleDoorLocally()
        now.t += 2_000
        d.tick(now.t)
        assert.equal(d.snapshot().door, 'opened')
        d.emitBlocked('door_blocked')
        d.emitUnblocked()
        assert.deepEqual(blocked, [{ reason: 'door_blocked', message: 'door_blocked' }])
        assert.equal(unblocked, 1)
    })
    it('is deterministic: the same seed replays the same trace', async () => {
        const trace = async () => {
            const now = { t: T0 }
            // Full noise, so the random source actually matters: a quiet scenario would replay
            // identically even with a broken seed.
            const scenario = botScenarioSchema.parse({})
            const seed = seeded(7)
            const d = createSimulatedDriver({ botId: 'ACME-0001', scenario, origin, scatterRadiusM: 40, now: () => now.t, random: seed })
            await d.start({ now: () => now.t, log: () => {} })
            const out: string[] = []
            await d.navigateTo({ id: 'J/a', target: { lat: 0.002, lng: 0 } })
            for (let i = 0; i < 200; i += 1) {
                now.t += 250
                d.tick(now.t)
                const s = d.snapshot()
                out.push(`${s.position?.lat.toFixed(9)},${s.position?.lng.toFixed(9)},${(s.speedMps ?? 0).toFixed(6)}`)
            }
            return out
        }
        assert.deepEqual(await trace(), await trace())
    })
})

describe('simulated() factory', () => {
    it('resolves a bundled scenario by name from the package, wherever the process was started', () => {
        const factory = simulated({ scenario: 'boolean-door' })
        const d = factory('ACME-0001', { origin })
        assert.equal(d.capabilities().hasDoor, true)
        assert.ok(listScenarios().includes('boolean-door'))
    })
    it('names override ids that are not in the roster', () => {
        const factory = simulated({ scenario: 'low-battery' })
        assert.deepEqual(factory.auditRoster?.(['ACME-0001', 'ACME-0002', 'ACME-0003']), [])
        assert.deepEqual(factory.auditRoster?.(['GW-0001']), ['ACME-0001', 'ACME-0002', 'ACME-0003'])
    })
})

const loadScenario = (name: string) => parseScenario(JSON.parse(readFileSync(scenarioPath(name), 'utf8')))

/**
 * A bot built from a bundled scenario FILE, at the origin, with the noise walk pinned. The seven
 * tests below are the product surface: each one must reproduce what the file's NAME promises, so
 * they read the shipped JSON rather than an inline scenario.
 */
function fromScenario(name: string, botId: string, nowRef: { t: number }) {
    const scenario = loadScenario(name)
    return createSimulatedDriver({
        botId,
        scenario: botScenarioFor(scenario, botId),
        origin,
        scatterRadiusM: 0,
        now: () => nowRef.t,
        random: fixed(0.5),
    })
}

describe('bundled scenarios', () => {
    it('there are exactly seven, by the names the README lists', () => {
        assert.deepEqual(listScenarios(), [
            'boolean-door',
            'default',
            'destination-correction',
            'low-battery',
            'never-arrives',
            'no-interrupt',
            'offline-flapping',
        ])
    })
    for (const name of listScenarios()) {
        it(`${name} parses (strict: a misspelled knob fails here)`, () => {
            parseScenario(JSON.parse(readFileSync(scenarioPath(name), 'utf8')))
        })
    }
    it('every scenario has a one-line note for `efk scenarios list` and the README', () => {
        assert.deepEqual(Object.keys(SCENARIO_NOTES).sort(), listScenarios())
    })
    it('low-battery keeps drainPctPerKm: 0 on the bot it overrides', () => {
        const scenario = parseScenario(JSON.parse(readFileSync(scenarioPath('low-battery'), 'utf8')))
        const b = botScenarioFor(scenario, 'ACME-0002')
        assert.equal(b.battery.startPct, 20)
        assert.equal(b.battery.drainPctPerKm, 0, 'the whole point of the scenario is a battery that sits exactly on the threshold')
    })
})

describe('each bundled scenario does what its name says', () => {
    it('default: the bot drives, arrives, and the delivery door answers', async () => {
        const now = { t: T0 }
        const d = fromScenario('default', 'ACME-0001', now)
        await d.start({ now: () => now.t, log: () => {} })
        const states: string[] = []
        const arrived: string[] = []
        d.on('commandState', (id, state) => states.push(`${id}:${state}`))
        d.on('arrived', (id) => arrived.push(id))
        const target = { lat: 0.0005, lng: 0 } // ≈ 56 m
        await d.navigateTo({ id: 'J/pickup', target })
        for (let i = 0; i < 200; i += 1) {
            now.t += 250
            d.tick(now.t)
        }
        assert.deepEqual(arrived, ['J/pickup'])
        assert.deepEqual(states, ['J/pickup:executing', 'J/pickup:succeeded'])
        assert.ok(metersBetween(d.snapshot().position ?? origin, target) < 0.01)
    })
    it('boolean-door: the lid reports only opened/closed, and answers when it finishes', async () => {
        const now = { t: T0 }
        const d = fromScenario('boolean-door', 'ACME-0001', now)
        await d.start({ now: () => now.t, log: () => {} })
        const states: string[] = []
        d.on('commandState', (_id, state) => states.push(state))
        await d.setDoor({ id: 'J/door', state: 'open' })
        const seen: string[] = []
        for (let i = 0; i < 12; i += 1) {
            now.t += 250
            d.tick(now.t)
            seen.push(d.snapshot().door)
        }
        assert.deepEqual([...new Set(seen)].sort(), ['closed', 'opened'], 'no opening/closing ever reaches remi')
        assert.deepEqual(states, ['succeeded'])
        assert.equal(seen.indexOf('opened'), 7, 'it flips when the lid finishes, not when the command arrives')
    })
    it('low-battery: ACME-0001..3 sit at 15/20/21 % and stay there while they drive', async () => {
        const bots = [
            { botId: 'ACME-0001', pct: 15 },
            { botId: 'ACME-0002', pct: 20 },
            { botId: 'ACME-0003', pct: 21 },
        ]
        for (const bot of bots) {
            const now = { t: T0 }
            const d = fromScenario('low-battery', bot.botId, now)
            await d.start({ now: () => now.t, log: () => {} })
            assert.equal(d.snapshot().batteryPercentage, bot.pct)
            await d.navigateTo({ id: 'J/a', target: { lat: 0.001, lng: 0 } }) // ≈ 111 m
            for (let i = 0; i < 400; i += 1) {
                now.t += 250
                d.tick(now.t)
            }
            assert.ok(metersBetween(d.snapshot().position ?? origin, origin) > 100, `${bot.botId} really drove`)
            assert.equal(d.snapshot().batteryPercentage, bot.pct, 'drainPctPerKm: 0 survives the per-bot override')
            assert.equal(d.snapshot().available, true, 'the kit does not decide eligibility; remi does')
        }
    })
    it('offline-flapping: 0001 never connects, 0002 alternates every 20 s, the rest stay up', async () => {
        const now = { t: T0 }
        const off = fromScenario('offline-flapping', 'ACME-0001', now)
        const flap = fromScenario('offline-flapping', 'ACME-0002', now)
        const other = fromScenario('offline-flapping', 'ACME-0003', now)
        for (const d of [off, flap, other]) await d.start({ now: () => now.t, log: () => {} })
        const sample = () => [off.wantsConnection(), flap.wantsConnection(), other.wantsConnection()]
        assert.deepEqual(sample(), [false, true, true])
        now.t += 10_000
        assert.deepEqual(sample(), [false, false, true], 'half a period in, the flapping bot has dropped')
        now.t += 10_000
        assert.deepEqual(sample(), [false, true, true], 'and it comes back a full period in')
        off.tick(now.t)
        assert.equal(off.snapshot().connected, false)
    })
    it('never-arrives: the bot parks one gap short and never confirms', async () => {
        const now = { t: T0 }
        const d = fromScenario('never-arrives', 'ACME-0001', now)
        await d.start({ now: () => now.t, log: () => {} })
        let arrived = 0
        const states: string[] = []
        d.on('arrived', () => arrived++)
        d.on('commandState', (_id, state) => states.push(state))
        const target = { lat: 0.0005, lng: 0 } // ≈ 56 m
        await d.navigateTo({ id: 'J/a', target })
        for (let i = 0; i < 400; i += 1) {
            now.t += 250
            d.tick(now.t)
        }
        assert.equal(arrived, 0)
        assert.deepEqual(states, ['executing'], 'it stays executing for ever: the job step times out at remi')
        assert.ok(Math.abs(metersBetween(d.snapshot().position ?? origin, target) - NEVER_ARRIVE_GAP_M) < 0.2)
        assert.equal(d.snapshot().speedMps, 0)
    })
    it('no-interrupt: inert on purpose — identical to default, with the knob documented where it lives', () => {
        // Controller ruling R18. `supports_command_interrupt` is a FLEET capability, not a per-bot
        // scenario field, so this file cannot carry it and parses exactly like `default.json`. It
        // ships because the design names seven scenarios; the note is what stops it being an
        // unexplained duplicate.
        assert.deepEqual(loadScenario('no-interrupt'), loadScenario('default'))
        const note = SCENARIO_NOTES['no-interrupt'] ?? ''
        assert.match(note, /supports_command_interrupt/)
        assert.match(note, /efk\.config\.ts/)
        assert.match(note, /BOT_BUSY/)
    })
    it('destination-correction: off-grid destinations snap, and 300 m out is rejected', async () => {
        const now = { t: T0 }
        const d = fromScenario('destination-correction', 'ACME-0001', now)
        await d.start({ now: () => now.t, log: () => {} })
        const snapped = await d.navigateTo({ id: 'J/a', target: { lat: 0.00011, lng: 0 } })
        assert.equal(snapped.kind, 'accepted_with_correction')
        assert.deepEqual(snapped.kind === 'accepted_with_correction' && snapped.position, { lat: 0.0002, lng: 0 })
        const far = await d.navigateTo({ id: 'J/b', target: { lat: 0.005, lng: 0 } }) // ≈ 556 m from the origin
        assert.equal(far.kind === 'rejected' && far.code, 'DESTINATION_UNREACHABLE')
        assert.equal(far.kind === 'rejected' && Math.round(far.correctionDistanceM ?? 0), 256)
        assert.equal((await d.validateDestination({ lat: 0.005, lng: 0 })).reachable, false)
        // And the bot drives to the SNAPPED point, not to the one remi asked for.
        for (let i = 0; i < 200; i += 1) {
            now.t += 250
            d.tick(now.t)
        }
        assert.ok(metersBetween(d.snapshot().position ?? origin, { lat: 0.0002, lng: 0 }) < 0.01)
    })
})
