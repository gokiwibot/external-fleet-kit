import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCommandLedger } from './command-ledger'

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
    it('markPublished on anything that is not the current rejection changes nothing', () => {
        const ledger = createCommandLedger({ now: () => T0 })
        ledger.accept('J/a', 'navigate_to')
        ledger.markPublished('J/a')
        assert.equal(ledger.current()?.id, 'J/a')
        ledger.markPublished('nope')
        assert.equal(ledger.current()?.id, 'J/a')
    })
})
