import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCommandLedger, MAX_UNPUBLISHED_TERMINALS } from './command-ledger'

const T0 = 1_800_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

describe('command ledger', () => {
    it('accept records accepted with accepted_at and becomes current_command', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        const status = ledger.accept('J/pickup', 'navigate_to')
        assert.deepEqual(status, { id: 'J/pickup', state: 'accepted', accepted_at: iso(T0) })
        assert.deepEqual(ledger.current(), status)
        assert.equal(ledger.activeNavigation(), 'J/pickup')
    })
    it('accept with a correction carries both fields', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        const status = ledger.accept('J/pickup', 'navigate_to', { position: { lat: 1, lng: 2 }, distanceM: 28.9 })
        assert.deepEqual(status.corrected_position, { lat: 1, lng: 2 })
        assert.equal(status.correction_distance_m, 28.9)
    })
    it('reject records rejected with rejected_at and no accepted_at', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        const status = ledger.reject('J/far', 'navigate_to', 'DESTINATION_UNREACHABLE', '340 m away', 340)
        assert.deepEqual(status, {
            id: 'J/far',
            state: 'rejected',
            rejected_at: iso(T0),
            error: { code: 'DESTINATION_UNREACHABLE', message: '340 m away' },
            correction_distance_m: 340,
        })
        assert.equal(ledger.activeNavigation(), null, 'a rejected navigation is not active')
    })
    it('transitions accepted → executing → succeeded and never back', () => {
        let now = T0
        const ledger = createCommandLedger({ now: () => now })
        ledger.accept('J/pickup', 'navigate_to')
        now += 1_000
        assert.equal(ledger.markExecuting('J/pickup'), true)
        assert.equal(ledger.current()?.state, 'executing')
        assert.equal(ledger.current()?.updated_at, iso(now))
        now += 1_000
        assert.equal(ledger.complete('J/pickup', 'succeeded'), true)
        assert.equal(ledger.markExecuting('J/pickup'), false, 'terminal states do not move')
        assert.equal(ledger.complete('J/pickup', 'failed', { code: 'X', message: 'x' }), false)
        assert.equal(ledger.current()?.state, 'succeeded')
        assert.equal(ledger.activeNavigation(), null)
    })
    it('failed carries the error', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        ledger.accept('J/pickup', 'navigate_to')
        ledger.complete('J/pickup', 'failed', { code: 'MOTOR_FAULT', message: 'left wheel' })
        assert.deepEqual(ledger.current()?.error, { code: 'MOTOR_FAULT', message: 'left wheel' })
    })
    it('replace marks the previous navigation failed with REPLACED internally only', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        ledger.accept('J/a', 'navigate_to')
        ledger.markExecuting('J/a')
        ledger.replace('J/a')
        ledger.accept('J/b', 'navigate_to')
        assert.equal(ledger.get('J/a')?.internalCode, 'REPLACED')
        assert.equal(ledger.get('J/a')?.status.state, 'failed')
        assert.equal(ledger.current()?.id, 'J/b', 'current_command is the new command, the replaced one never shows')
        assert.equal(ledger.activeNavigation(), 'J/b')
    })
    it('unknown ids are ignored by markExecuting/complete', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        assert.equal(ledger.markExecuting('nope'), false)
        assert.equal(ledger.complete('nope', 'succeeded'), false)
    })
    it('cancel_navigation and set_door do not become the active navigation', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        ledger.accept('J/pickup', 'navigate_to')
        ledger.accept('J/pickup/door-open', 'set_door')
        assert.equal(ledger.current()?.id, 'J/pickup/door-open')
        assert.equal(ledger.activeNavigation(), 'J/pickup')
    })
    it('a rejection holds current_command for one published state, then gives the slot back to the live navigation', () => {
        let now = T0
        const ledger = createCommandLedger({ now: () => now })
        ledger.accept('J/a', 'navigate_to')
        ledger.markExecuting('J/a')
        now += 1_000
        ledger.reject('J/b', 'navigate_to', 'BOT_BUSY', 'busy with J/a')

        // Before any publish: remi must see the rejection, so it owns the slot.
        assert.equal(ledger.current()?.id, 'J/b')
        assert.equal(ledger.current()?.state, 'rejected')

        ledger.markPublished('J/b')

        // Published once: the slot goes back to the command that is still running.
        assert.equal(ledger.current()?.id, 'J/a')
        assert.equal(ledger.current()?.state, 'executing')

        now += 1_000
        assert.equal(ledger.complete('J/a', 'succeeded'), true)
        assert.equal(ledger.current()?.id, 'J/a')
        assert.equal(
            ledger.current()?.state,
            'succeeded',
            'the success of J/a reaches remi, which it never would if the rejection had stuck',
        )
    })
    it('an unpublished rejection is not displaced by a command accepted before the next tick', () => {
        let now = T0
        const ledger = createCommandLedger({ now: () => now })
        ledger.reject('J/b', 'navigate_to', 'BOT_BUSY', 'busy elsewhere')
        now += 10

        // Same 250 ms tick: nothing has been published yet, so the rejection still owns the slot —
        // otherwise remi never learns J/b was refused and the job step hangs until it times out.
        ledger.accept('J/c', 'navigate_to')
        assert.equal(ledger.current()?.id, 'J/b')
        assert.equal(ledger.current()?.state, 'rejected')

        // And the hold is not forever: once remi has seen the rejection, the new command takes over.
        ledger.markPublished('J/b')
        assert.equal(ledger.current()?.id, 'J/c')
        assert.equal(ledger.current()?.state, 'accepted')
    })
    it('a rejection with nothing else running stays in the slot for ever', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        ledger.reject('J/far', 'navigate_to', 'DESTINATION_UNREACHABLE', '340 m away', 340)
        ledger.markPublished('J/far')
        assert.equal(ledger.current()?.id, 'J/far')
        assert.equal(ledger.current()?.state, 'rejected')
    })
    it('every terminal reaches the slot, oldest first, and then the slot goes back to the live command', () => {
        let now = T0
        const ledger = createCommandLedger({ now: () => now })
        ledger.accept('J/a', 'navigate_to')
        ledger.accept('J/a/door-open', 'set_door')
        now += 1_000
        ledger.complete('J/a/door-open', 'failed', { code: 'DOOR_STALLED', message: 'the door did not open' })
        now += 1_000
        ledger.reject('J/c', 'navigate_to', 'BOT_BUSY', 'busy with J/a')

        // FIFO: the door failed first, so that is the outcome remi is told about first.
        assert.equal(ledger.current()?.id, 'J/a/door-open')
        assert.equal(ledger.current()?.state, 'failed')
        ledger.markPublished('J/a/door-open')
        assert.equal(ledger.current()?.id, 'J/c')
        assert.equal(ledger.current()?.state, 'rejected')
        ledger.markPublished('J/c')

        // Queue drained: the navigation that is still running gets the slot back, so it never starves.
        assert.equal(ledger.current()?.id, 'J/a')
        assert.equal(ledger.current()?.state, 'accepted')
        assert.equal(ledger.activeNavigation(), 'J/a')
    })
    it('a terminal that has already been published never returns to the slot', () => {
        let now = T0
        const ledger = createCommandLedger({ now: () => now })
        ledger.accept('J/a', 'navigate_to')
        ledger.accept('J/a/door-open', 'set_door')
        now += 1_000
        ledger.complete('J/a/door-open', 'succeeded')
        assert.equal(ledger.current()?.id, 'J/a/door-open')

        ledger.markPublished('J/a/door-open')
        assert.equal(ledger.current()?.id, 'J/a', 'the outcome was shown once and the slot moved on')

        // Publishing again, or publishing the live command, does not bring the outcome back.
        ledger.markPublished('J/a/door-open')
        assert.equal(ledger.current()?.id, 'J/a')
        ledger.markPublished('J/a')
        assert.equal(ledger.current()?.id, 'J/a')
    })
    it('complete refuses a failed terminal with no error, which the contract would not accept', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        ledger.accept('J/pickup', 'navigate_to')
        ledger.markExecuting('J/pickup')
        // The overloads refuse this call at compile time; the cast is the JavaScript caller the
        // runtime guard exists for. commandStatusSchema requires `error` when state is failed.
        const loose = ledger.complete as (
            id: string,
            terminal: 'succeeded' | 'failed',
            error?: { code: string; message: string },
        ) => boolean
        assert.equal(loose('J/pickup', 'failed'), false)
        assert.equal(ledger.get('J/pickup')?.status.state, 'executing', 'the refused completion moved nothing')
        assert.equal(ledger.current()?.id, 'J/pickup')
        assert.equal(ledger.current()?.state, 'executing')
    })
    it('the same id sent three times is recorded once and a resend never moves the status', () => {
        let now = T0
        const ledger = createCommandLedger({ now: () => now })
        const first = ledger.accept('J/pickup', 'navigate_to')
        const entry = ledger.get('J/pickup')
        now += 1_000
        const second = ledger.accept('J/pickup', 'navigate_to')
        now += 1_000
        const third = ledger.accept('J/pickup', 'navigate_to')
        assert.deepEqual(second, first)
        assert.deepEqual(third, first)
        assert.equal(third.accepted_at, iso(T0), 'a resend does not restamp the command')
        assert.equal(ledger.get('J/pickup'), entry, 'one entry, not three')

        // A resend that arrives after the command finished answers with the terminal, never behind it.
        ledger.markExecuting('J/pickup')
        now += 1_000
        ledger.complete('J/pickup', 'succeeded')
        now += 1_000
        assert.equal(ledger.accept('J/pickup', 'navigate_to').state, 'succeeded')
        assert.equal(ledger.current()?.state, 'succeeded')
    })
    it('a resend of a rejected id does not queue the rejection twice', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        const first = ledger.reject('J/far', 'navigate_to', 'DESTINATION_UNREACHABLE', '340 m away', 340)
        assert.deepEqual(ledger.reject('J/far', 'navigate_to', 'DESTINATION_UNREACHABLE', '340 m away', 340), first)
        ledger.accept('J/near', 'navigate_to')
        assert.equal(ledger.current()?.id, 'J/far')
        ledger.markPublished('J/far')
        assert.equal(ledger.current()?.id, 'J/near', 'one rejection, published once, and the slot moves on')
    })
    it('markExecuting on an executing command, and replace on a terminal or an unknown id, do nothing', () => {
        let now = T0
        const ledger = createCommandLedger({ now: () => now })
        ledger.accept('J/a', 'navigate_to')
        assert.equal(ledger.markExecuting('J/a'), true)
        now += 1_000
        assert.equal(ledger.markExecuting('J/a'), false, 'already executing')
        assert.equal(ledger.get('J/a')?.status.updated_at, iso(T0), 'the refused transition did not restamp it')

        ledger.complete('J/a', 'succeeded')
        ledger.replace('J/a')
        assert.equal(ledger.get('J/a')?.status.state, 'succeeded', 'a terminal is not replaced')
        assert.equal(ledger.get('J/a')?.internalCode, undefined)

        ledger.replace('nope')
        assert.equal(ledger.get('nope'), undefined)
    })
    it('markPublished on anything that is not the current rejection changes nothing', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        ledger.accept('J/a', 'navigate_to')
        ledger.markPublished('J/a')
        assert.equal(ledger.current()?.id, 'J/a')
        ledger.markPublished('nope')
        assert.equal(ledger.current()?.id, 'J/a')
    })
    it('bounds the queue of unpublished outcomes at MAX_UNPUBLISHED_TERMINALS by default, oldest out first', () => {
        const dropped: Array<{ id: string; pending: number }> = []
        const ledger = createCommandLedger({ now: () => T0, onTerminalDropped: (id, pending) => dropped.push({ id, pending }) })
        // A bot that cannot publish for hours while commands keep arriving: the outcomes must not
        // pile up without end, and the ones remi is still waiting for are the newest.
        for (let i = 0; i < MAX_UNPUBLISHED_TERMINALS + 2; i += 1) ledger.reject(`J/${i}`, 'navigate_to', 'BOT_BUSY', 'busy')
        assert.deepEqual(dropped, [
            { id: 'J/0', pending: MAX_UNPUBLISHED_TERMINALS },
            { id: 'J/1', pending: MAX_UNPUBLISHED_TERMINALS },
        ])
        assert.equal(ledger.current()?.id, 'J/2', 'the head is the oldest outcome that survived')
        for (let i = 2; i < MAX_UNPUBLISHED_TERMINALS + 1; i += 1) ledger.markPublished(`J/${i}`)
        assert.equal(ledger.current()?.id, `J/${MAX_UNPUBLISHED_TERMINALS + 1}`, 'and the newest is still there to be published')
    })
})
