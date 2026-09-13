import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { type BotCommand, type BotState, commandStatusSchema } from '../contract/schemas'
import { createBotRuntime } from './bot-runtime'
import { createCadence } from './cadence'
import { createCommandLedger } from './command-ledger'
import { createEventBus } from './events'
import { FakeClock, FakeDriver } from './fakes'
import { createSeq } from './seq'
import { createStateStore } from './state-store'

// Every temp directory is remembered so the run leaves nothing behind, in the repo or in /tmp.
const dirs: string[] = []
after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function harness(overrides: { supportsCommandInterrupt?: boolean; maxUnpublishedTerminals?: number } = {}) {
    const clock = new FakeClock()
    const driver = new FakeDriver('ACME-0001')
    const bus = createEventBus()
    const warnings: string[] = []
    bus.on('log', (l) => {
        if (l.level === 'warn') warnings.push(l.message)
    })
    const ledger = createCommandLedger({
        now: clock.now,
        maxUnpublishedTerminals: overrides.maxUnpublishedTerminals,
        // What Task 8 wires: the cap must never discard an outcome quietly.
        onTerminalDropped: (id, pending) =>
            bus.emit('log', {
                level: 'warn',
                botId: 'ACME-0001',
                message: `dropped the outcome of ${id}: ${pending} still waiting to be published`,
            }),
    })
    const dir = mkdtempSync(join(tmpdir(), 'efk-'))
    dirs.push(dir)
    const seq = createSeq(createStateStore(join(dir, '.efk-state.json')), {
        // The debounced write must not hold the test process open for a second per harness.
        setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
    })
    const runtime = createBotRuntime({
        botId: 'ACME-0001',
        driver,
        ledger,
        cadence: createCadence(),
        seq,
        bus,
        now: clock.now,
        fleet: { supportsCommandInterrupt: overrides.supportsCommandInterrupt ?? true },
    })
    return { clock, driver, bus, ledger, seq, warnings, runtime }
}

/** A transport that takes everything, and remembers what it took. */
const accepting = () => {
    const sent: BotState[] = []
    const send = (state: BotState) => {
        sent.push(state)
        return true
    }
    return { sent, send }
}
/** A transport that is down (MQTT link lost) or switched off (HTTP without push). */
const refusing = () => false

const nav = (id: string, issuedAt: number, extra: Partial<BotCommand> = {}): BotCommand => ({
    id,
    type: 'navigate_to',
    params: { lat: 33.9701, lng: -118.4148 },
    issued_at: new Date(issuedAt).toISOString(),
    ...extra,
})

describe('bot runtime — commands', () => {
    it('accepts a navigate_to once; the same id again is a duplicate and never reaches the driver', async () => {
        const { clock, driver, runtime } = harness()
        const first = await runtime.handleCommand(nav('J/pickup', clock.nowMs), 'http')
        assert.equal(first.kind, 'accepted')
        const again = await runtime.handleCommand(nav('J/pickup', clock.nowMs), 'http')
        assert.equal(again.kind, 'duplicate')
        assert.equal(driver.calls.length, 1)
        assert.equal(runtime.currentCommand()?.id, 'J/pickup')
    })
    it('rejects an expired command without calling the driver', async () => {
        const { clock, driver, runtime } = harness()
        const outcome = await runtime.handleCommand(
            nav('J/late', clock.nowMs, { expires_at: new Date(clock.nowMs - 1).toISOString() }),
            'mqtt',
        )
        assert.deepEqual(outcome, { kind: 'rejected', code: 'COMMAND_EXPIRED', message: 'expires_at is in the past' })
        assert.equal(driver.calls.length, 0)
        assert.equal(runtime.currentCommand()?.state, 'rejected')
    })
    it('rejects a command type the driver does not declare', async () => {
        const { clock, driver, runtime } = harness()
        driver.caps = { has_door: false, supported_commands: ['navigate_to', 'cancel_navigation'] }
        const outcome = await runtime.handleCommand(
            { id: 'J/door', type: 'set_door', params: { state: 'open' }, issued_at: new Date(clock.nowMs).toISOString() },
            'mqtt',
        )
        assert.equal(outcome.kind, 'rejected')
        assert.equal(outcome.kind === 'rejected' && outcome.code, 'UNSUPPORTED_COMMAND')
        assert.equal(driver.calls.length, 0)
    })
    it('a second navigate_to replaces the first when the fleet supports interrupt', async () => {
        const { clock, driver, runtime } = harness({ supportsCommandInterrupt: true })
        await runtime.handleCommand(nav('J/a', clock.nowMs), 'mqtt')
        driver.fire('commandState', 'J/a', 'executing')
        const second = await runtime.handleCommand(nav('J/b', clock.nowMs), 'mqtt')
        assert.equal(second.kind, 'accepted')
        assert.equal(runtime.currentCommand()?.id, 'J/b')
        assert.equal(driver.calls.length, 2)
    })
    it('a second navigate_to is BOT_BUSY when the fleet does not support interrupt', async () => {
        const { clock, driver, runtime } = harness({ supportsCommandInterrupt: false })
        await runtime.handleCommand(nav('J/a', clock.nowMs), 'mqtt')
        driver.fire('commandState', 'J/a', 'executing')
        const second = await runtime.handleCommand(nav('J/b', clock.nowMs), 'mqtt')
        assert.equal(second.kind === 'rejected' && second.code, 'BOT_BUSY')
        assert.equal(driver.calls.length, 1)
        assert.equal(runtime.currentCommand()?.id, 'J/b', 'the rejection is what remi sees in the state')
    })
    it('a correction from the driver lands in current_command', async () => {
        const { clock, driver, runtime } = harness()
        driver.accept = { kind: 'accepted_with_correction', position: { lat: 33.9703, lng: -118.4146 }, distanceM: 28.9 }
        const outcome = await runtime.handleCommand(nav('J/pickup', clock.nowMs), 'http')
        assert.equal(outcome.kind, 'accepted')
        assert.deepEqual(runtime.currentCommand()?.corrected_position, { lat: 33.9703, lng: -118.4146 })
    })
    it('a driver rejection with DESTINATION_UNREACHABLE keeps the distance', async () => {
        const { clock, driver, runtime } = harness()
        driver.accept = { kind: 'rejected', code: 'DESTINATION_UNREACHABLE', message: 'too far', correctionDistanceM: 340 }
        await runtime.handleCommand(nav('J/far', clock.nowMs), 'mqtt')
        assert.equal(runtime.currentCommand()?.correction_distance_m, 340)
    })
    it('a throwing driver is DRIVER_ERROR and current_command does not change', async () => {
        const { clock, driver, runtime } = harness()
        await runtime.handleCommand(nav('J/a', clock.nowMs), 'mqtt')
        driver.throwOnNext = true
        const outcome = await runtime.handleCommand(nav('J/b', clock.nowMs), 'mqtt')
        assert.equal(outcome.kind, 'driver_error')
        assert.equal(runtime.currentCommand()?.id, 'J/a')
        const retry = await runtime.handleCommand(nav('J/b', clock.nowMs), 'mqtt')
        assert.equal(retry.kind, 'accepted', 'the same id retried after a driver error is not a duplicate')
    })
    it('cancel_navigation with nothing to cancel is accepted and succeeded immediately', async () => {
        const { clock, runtime } = harness()
        const outcome = await runtime.handleCommand(
            { id: 'J/cancel', type: 'cancel_navigation', params: {}, issued_at: new Date(clock.nowMs).toISOString() },
            'mqtt',
        )
        assert.equal(outcome.kind, 'accepted')
        assert.equal(runtime.currentCommand()?.state, 'succeeded')
    })
    it('cancel_navigation ENDS the navigation it cancels, so the bot is free for the next one', async () => {
        const { clock, driver, runtime } = harness({ supportsCommandInterrupt: false })
        await runtime.handleCommand(nav('J/a', clock.nowMs), 'mqtt')
        driver.fire('commandState', 'J/a', 'executing')
        const cancel = await runtime.handleCommand(
            { id: 'J/cancel', type: 'cancel_navigation', params: {}, issued_at: new Date(clock.nowMs).toISOString() },
            'mqtt',
        )
        assert.equal(cancel.kind, 'accepted')
        assert.equal(runtime.ledgerEntry('J/a')?.status.state, 'failed', 'the cancelled navigation is over, not still running')
        assert.deepEqual(runtime.ledgerEntry('J/a')?.status.error, {
            code: 'CANCELLED',
            message: 'cancelled by cancel_navigation J/cancel',
        })
        assert.equal(runtime.ledgerEntry('J/a')?.internalCode, undefined, 'CANCELLED is a real failure, not the internal REPLACED marker')

        // Without this, a fleet that does not support interrupt would answer BOT_BUSY for ever.
        const next = await runtime.handleCommand(nav('J/b', clock.nowMs), 'mqtt')
        assert.equal(next.kind, 'accepted')
        // How J/a ended is an outcome remi is owed, so it holds the single slot until it is published;
        // only then does the slot move on to the navigation that is actually running.
        assert.equal(runtime.currentCommand()?.id, 'J/a')
        await runtime.tick(clock.nowMs, accepting().send)
        assert.equal(runtime.currentCommand()?.id, 'J/b')
    })
    it('driver events move the command: executing, arrived → succeeded, and ignore unknown or terminal ids', async () => {
        const { clock, driver, runtime, bus } = harness()
        const warnings: string[] = []
        bus.on('log', (l) => {
            if (l.level === 'warn') warnings.push(l.message)
        })
        await runtime.handleCommand(nav('J/pickup', clock.nowMs), 'mqtt')
        driver.fire('commandState', 'J/pickup', 'executing')
        assert.equal(runtime.currentCommand()?.state, 'executing')
        driver.fire('arrived', 'J/pickup')
        assert.equal(runtime.currentCommand()?.state, 'succeeded')

        // The simulated driver (and most real ones) emit `arrived` AND `commandState(succeeded)`.
        // Repeating the state a command already holds is a no-op, not something to warn about.
        driver.fire('commandState', 'J/pickup', 'succeeded')
        assert.equal(runtime.currentCommand()?.state, 'succeeded')
        assert.deepEqual(warnings, [], 'no warning for a repeat of the state the command already has')

        driver.fire('commandState', 'J/pickup', 'failed', { code: 'X', message: 'late' })
        assert.equal(runtime.currentCommand()?.state, 'succeeded', 'terminal never moves back')
        assert.equal(warnings.length, 1, 'succeeded → failed IS an invalid transition and is worth a line')
        driver.fire('arrived', 'nope')
        assert.equal(runtime.currentCommand()?.id, 'J/pickup')
    })
    it('a driver failure with no error is refused and said out loud, because the contract needs a reason', async () => {
        const { clock, driver, runtime, warnings } = harness()
        await runtime.handleCommand(nav('J/pickup', clock.nowMs), 'mqtt')
        driver.fire('commandState', 'J/pickup', 'failed')
        assert.equal(runtime.currentCommand()?.state, 'accepted', 'a failure the schema would drop is not recorded')
        assert.equal(warnings.length, 1)
        assert.match(warnings[0] ?? '', /must carry an error/)
    })
    it('exposes the ledger entry and the driver destination check the HTTP transport needs', async () => {
        const { clock, runtime } = harness()
        await runtime.handleCommand(nav('J/pickup', clock.nowMs), 'http')
        assert.equal(runtime.ledgerEntry('J/pickup')?.status.id, 'J/pickup')
        assert.equal(runtime.ledgerEntry('GW-5867/pickup'), undefined)
        assert.deepEqual(await runtime.validateDestination({ lat: 1, lng: 2 }), {
            reachable: true,
            corrected_position: { lat: 1, lng: 2 },
            correction_distance_m: 0,
        })
    })
})

describe('bot runtime — state assembly and cadence', () => {
    it('assembles a valid BotState with timestamp and current_command, and WITHOUT seq', async () => {
        const { clock, runtime } = harness()
        await runtime.handleCommand(nav('J/pickup', clock.nowMs), 'mqtt')
        const result = runtime.assemble(clock.nowMs)
        assert.equal(result.ok, true)
        if (!result.ok) return
        assert.equal(result.state.bot_id, 'ACME-0001')
        assert.equal(result.state.seq, undefined, 'polling does not consume the counter; the contract makes seq optional there')
        assert.equal(result.state.timestamp, new Date(clock.nowMs).toISOString())
        assert.equal(result.state.current_command?.id, 'J/pickup')
        assert.equal(result.state.door, 'closed')
    })
    it('two consecutive polls never claim the same seq, because they carry none', () => {
        const { clock, runtime } = harness()
        const first = runtime.assemble(clock.nowMs)
        clock.advance(250)
        const second = runtime.assemble(clock.nowMs)
        assert.equal(first.ok && first.state.seq, undefined)
        assert.equal(second.ok && second.state.seq, undefined)
    })
    it('two consecutive pushes carry consecutive seq', async () => {
        const { clock, runtime } = harness()
        const transport = accepting()
        const a = await runtime.tick(clock.nowMs, transport.send)
        clock.advance(15_000)
        const b = await runtime.tick(clock.nowMs, transport.send)
        assert.equal(a?.seq, 1)
        assert.equal(b?.seq, 2)
        assert.deepEqual(
            transport.sent.map((state) => state.seq),
            [1, 2],
            'the transport carried exactly what the tick returned',
        )
    })
    it('does not assemble without a position, counts the drop and reports why', async () => {
        const { clock, driver, runtime, bus } = harness()
        const drops: string[] = []
        bus.on('state.dropped', (d) => drops.push(d.reason))
        driver.snap = { ...driver.snap, position: null }
        const result = runtime.assemble(clock.nowMs)
        assert.equal(result.ok, false)
        assert.equal(runtime.lastValidState(), null, 'never had a position: there is nothing to serve')
        assert.equal(await runtime.tick(clock.nowMs, accepting().send), null)
        assert.equal(runtime.dropped(), 1)
        assert.match(drops[0] ?? '', /position/)
    })
    it('remembers the last state that did assemble, so GET /bots can still list the bot', () => {
        const { clock, driver, runtime } = harness()
        const first = runtime.assemble(clock.nowMs)
        assert.equal(first.ok, true)
        clock.advance(5_000)
        driver.snap = { ...driver.snap, position: null }
        assert.equal(runtime.assemble(clock.nowMs).ok, false)
        assert.equal(
            runtime.lastValidState()?.timestamp,
            first.ok ? first.state.timestamp : '',
            'the old timestamp is kept: remi must be able to see how stale it is',
        )
    })
    it('tick publishes on the first call, then obeys cadence: idle heartbeat at 15 s, moving every 1 s, change now', async () => {
        const { clock, driver, runtime } = harness()
        const { send } = accepting()
        assert.ok(await runtime.tick(clock.nowMs, send), 'first publish')
        clock.advance(250)
        assert.equal(await runtime.tick(clock.nowMs, send), null)
        clock.advance(15_000)
        assert.ok(await runtime.tick(clock.nowMs, send), 'idle heartbeat')
        driver.snap = { ...driver.snap, speedMps: 1.4 }
        clock.advance(500)
        assert.equal(await runtime.tick(clock.nowMs, send), null, 'moving but 500 ms')
        clock.advance(500)
        assert.ok(await runtime.tick(clock.nowMs, send), 'moving, 1 s')
        driver.snap = { ...driver.snap, door: 'opened' }
        driver.fire('stateChanged')
        clock.advance(250)
        assert.ok(await runtime.tick(clock.nowMs, send), 'door changed → publish within the second')
    })
    it('seq increments only on publish', async () => {
        const { clock, runtime } = harness()
        const { send } = accepting()
        const a = await runtime.tick(clock.nowMs, send)
        clock.advance(250)
        await runtime.tick(clock.nowMs, send)
        clock.advance(15_000)
        const b = await runtime.tick(clock.nowMs, send)
        assert.equal(a?.seq, 1)
        assert.equal(b?.seq, 2)
    })
})

describe('bot runtime — the publish seam', () => {
    it('a refused publish burns no seq: the counter moves when the transport confirms, not when the tick fires', async () => {
        const { clock, seq, runtime } = harness()
        assert.equal(await runtime.tick(clock.nowMs, refusing), null, 'the link is down: nothing was published')
        assert.equal(seq.peek('ACME-0001'), 0, 'and nothing was counted')
        clock.advance(15_000)
        assert.equal(await runtime.tick(clock.nowMs, refusing), null)
        assert.equal(seq.peek('ACME-0001'), 0, 'an hour offline would leave it here too')
        clock.advance(15_000)
        const published = await runtime.tick(clock.nowMs, accepting().send)
        assert.equal(published?.seq, 1, 'the first state remi actually receives is seq 1')
    })
    it('a refused publish spends the tick: the next attempt waits for the cadence instead of retrying 250 ms later', async () => {
        const { clock, runtime } = harness()
        let attempts = 0
        const refuse = () => {
            attempts += 1
            return false
        }
        assert.equal(await runtime.tick(clock.nowMs, refuse), null)
        assert.equal(attempts, 1)
        clock.advance(250)
        assert.equal(await runtime.tick(clock.nowMs, refuse), null)
        assert.equal(attempts, 1, 'idle and unchanged: the refused attempt was this window turn, so nothing is re-rendered')
        clock.advance(14_750)
        assert.equal(await runtime.tick(clock.nowMs, refuse), null)
        assert.equal(attempts, 2, 'and the heartbeat tries again')
    })
    it('a dropped assemble does NOT spend the change: the contract still owes it a state within the second', async () => {
        const { clock, driver, runtime } = harness()
        const { send } = accepting()
        assert.ok(await runtime.tick(clock.nowMs, send), 'the bot is publishing normally')

        // A door change that happens to coincide with a momentary loss of position.
        driver.snap = { ...driver.snap, door: 'opened', position: null }
        driver.fire('stateChanged')
        clock.advance(250)
        assert.equal(await runtime.tick(clock.nowMs, send), null, 'nothing could be assembled')
        assert.equal(runtime.dropped(), 1)

        driver.snap = { ...driver.snap, position: { lat: 33.97, lng: -118.41 } }
        clock.advance(250)
        const published = await runtime.tick(clock.nowMs, send)
        assert.equal(published?.door, 'opened', 'published 500 ms after the change, not at the next 15 s heartbeat')
        assert.equal(published?.seq, 2)
    })
    it('the counter is untouched while the publish is in flight, and stamped on the state the transport gets', async () => {
        const { clock, seq, runtime } = harness()
        let seenInside: number | undefined
        const published = await runtime.tick(clock.nowMs, (state) => {
            seenInside = seq.peek('ACME-0001')
            return state.seq === 1
        })
        assert.equal(seenInside, 0, 'the seq travelling in the state is reserved, not yet consumed')
        assert.equal(published?.seq, 1)
        assert.equal(seq.peek('ACME-0001'), 1, 'and consumed only after the transport said yes')
    })
    it('a transport that throws is a refusal, not a crash, and costs no seq', async () => {
        const { clock, seq, bus, runtime } = harness()
        const errors: string[] = []
        bus.on('log', (l) => {
            if (l.level === 'error') errors.push(l.message)
        })
        const published = await runtime.tick(clock.nowMs, () => {
            throw new Error('socket closed')
        })
        assert.equal(published, null)
        assert.equal(seq.peek('ACME-0001'), 0)
        assert.match(errors[0] ?? '', /socket closed/)
    })
    it('a refused publish does not drain the outcomes: remi has learned nothing, so they stay pending', async () => {
        const { clock, driver, runtime } = harness()
        await runtime.handleCommand(nav('J/a', clock.nowMs), 'mqtt')
        driver.fire('arrived', 'J/a')
        await runtime.handleCommand(nav('J/b', clock.nowMs, { expires_at: new Date(clock.nowMs - 1).toISOString() }), 'mqtt')
        assert.equal(runtime.currentCommand()?.id, 'J/a', 'two outcomes queued, oldest first')

        assert.equal(await runtime.tick(clock.nowMs, refusing), null)
        assert.equal(runtime.currentCommand()?.id, 'J/a', 'the refused state drained nothing')

        clock.advance(15_000)
        const first = await runtime.tick(clock.nowMs, accepting().send)
        assert.equal(first?.current_command?.id, 'J/a')
        assert.equal(first?.seq, 1, 'the refused attempt consumed no counter')
        clock.advance(15_000)
        const second = await runtime.tick(clock.nowMs, accepting().send)
        assert.equal(second?.current_command?.id, 'J/b', 'and a confirmed one drains the head')
        assert.equal(second?.seq, 2)
    })
    it('a poll that was served drains the outcome too, and still consumes no seq', async () => {
        const { clock, driver, runtime } = harness()
        await runtime.handleCommand(nav('J/a', clock.nowMs), 'http')
        driver.fire('arrived', 'J/a')
        await runtime.handleCommand(nav('J/b', clock.nowMs, { expires_at: new Date(clock.nowMs - 1).toISOString() }), 'http')

        const served = runtime.assemble(clock.nowMs)
        assert.equal(served.ok && served.state.current_command?.id, 'J/a')
        assert.equal(served.ok && served.state.seq, undefined)
        if (served.ok) runtime.markServed(served.state)
        assert.equal(runtime.currentCommand()?.id, 'J/b', 'answering GET /bots IS the delivery in polling mode')

        const pushed = await runtime.tick(clock.nowMs, accepting().send)
        assert.equal(pushed?.seq, 1, 'the served polls consumed no counter')
    })
    it('a buffered state counts as published only when the transport confirms it, and only once', async () => {
        const { clock, runtime, seq, warnings } = harness()
        const expired = (id: string) =>
            runtime.handleCommand(nav(id, clock.nowMs, { expires_at: new Date(clock.nowMs - 1).toISOString() }), 'http')
        await expired('J/a')
        await expired('J/b')
        // What the HTTP push transport answers: the state is in this tick's batch, not at remi.
        const buffered: BotState[] = []
        const pushed = await runtime.tick(clock.nowMs, (state) => {
            buffered.push(state)
            return false
        })
        assert.equal(pushed, null)
        assert.equal(seq.peek('ACME-0001'), 0, 'a state sitting in a buffer has spent no counter')
        assert.equal(runtime.currentCommand()?.id, 'J/a', 'and drained no outcome')
        const state = buffered[0]
        assert.ok(state)
        assert.equal(runtime.confirmPublished(state), true)
        assert.equal(seq.peek('ACME-0001'), 1)
        assert.equal(runtime.currentCommand()?.id, 'J/b', 'the batch landed, so the head moves on')
        assert.equal(
            runtime.confirmPublished(state),
            false,
            'a second confirmation would burn a counter and pop an outcome remi has not seen',
        )
        assert.match(warnings.join('\n'), /publish confirmation for seq 1/)
    })
    it('a state from another bot never acknowledges this one', async () => {
        const { clock, driver, runtime } = harness()
        await runtime.handleCommand(nav('J/a', clock.nowMs), 'http')
        driver.fire('arrived', 'J/a')
        const served = runtime.assemble(clock.nowMs)
        assert.equal(served.ok, true)
        if (!served.ok) return
        runtime.markServed({ ...served.state, bot_id: 'ACME-0002' })
        assert.equal(runtime.currentCommand()?.id, 'J/a', 'still pending')
    })
    it('caps the queue of unpublished outcomes, drops the OLDEST, and says so', async () => {
        const { clock, runtime, warnings } = harness({ maxUnpublishedTerminals: 2 })
        const expired = (id: string) =>
            runtime.handleCommand(nav(id, clock.nowMs, { expires_at: new Date(clock.nowMs - 1).toISOString() }), 'mqtt')
        await expired('J/1')
        await expired('J/2')
        await expired('J/3')
        assert.equal(warnings.length, 1, 'the discarded outcome is never silent')
        assert.match(warnings[0] ?? '', /J\/1/)
        assert.equal(runtime.currentCommand()?.id, 'J/2', 'the oldest went, the ones remi is still waiting for stayed')

        const first = await runtime.tick(clock.nowMs, accepting().send)
        assert.equal(first?.current_command?.id, 'J/2')
        clock.advance(15_000)
        const second = await runtime.tick(clock.nowMs, accepting().send)
        assert.equal(second?.current_command?.id, 'J/3')
    })
    it('never lets the internal REPLACED marker into a state, even though the contract schema would take it', async () => {
        const { clock, ledger, runtime } = harness()
        await runtime.handleCommand(nav('J/a', clock.nowMs), 'mqtt')
        await runtime.tick(clock.nowMs, accepting().send)

        // The ledger's fallback slot (nothing queued, nothing live) hands back the replaced entry.
        ledger.replace('J/a')
        const leaked = ledger.current()
        assert.equal(leaked?.id, 'J/a')
        assert.equal(leaked?.error?.code, 'REPLACED')
        assert.equal(
            commandStatusSchema.safeParse(leaked).success,
            true,
            'and the schema would NOT stop it: on a failed, error.code is a free string',
        )

        assert.equal(runtime.currentCommand(), null, 'the runtime is what stops it')
        const result = runtime.assemble(clock.nowMs)
        assert.equal(result.ok, true)
        assert.equal(
            result.ok && result.state.current_command,
            null,
            'the slot goes out empty rather than carry a code remi has never heard of',
        )
        clock.advance(15_000)
        const pushed = await runtime.tick(clock.nowMs, accepting().send)
        assert.equal(pushed?.current_command, null)
    })
})
