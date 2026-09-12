import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { botStateSchema, commandStatusSchema, fleetCapabilitiesSchema, problemDetailsSchema } from './schemas'

const base = {
    bot_id: 'ACME-0142',
    timestamp: '2026-09-01T14:22:31.000Z',
    available: true,
    connected: true,
    position: { lat: 33.9701, lng: -118.4148 },
    battery: { percentage: 74 },
    door: 'closed',
    current_command: null,
}

describe('botStateSchema', () => {
    it('accepts a complete state and rejects an unknown key (strict)', () => {
        assert.equal(botStateSchema.safeParse(base).success, true)
        assert.equal(botStateSchema.safeParse({ ...base, heading: 90 }).success, false, 'heading is not in the contract')
    })
    it('requires every required field', () => {
        const { position: _position, ...noPosition } = base
        assert.equal(botStateSchema.safeParse(noPosition).success, false)
    })
    it('accepts all seven door values and nothing else', () => {
        for (const door of ['opened', 'closed', 'opening', 'closing', 'stalled', 'unknown', 'unsupported']) {
            assert.equal(botStateSchema.safeParse({ ...base, door }).success, true, door)
        }
        assert.equal(botStateSchema.safeParse({ ...base, door: 'open' }).success, false)
    })
    it('battery percentage is an integer 0-100', () => {
        assert.equal(botStateSchema.safeParse({ ...base, battery: { percentage: 74.5 } }).success, false)
        assert.equal(botStateSchema.safeParse({ ...base, battery: { percentage: 101 } }).success, false)
    })
})

describe('commandStatusSchema (post-N2)', () => {
    it('accepted/executing/succeeded/failed require accepted_at', () => {
        assert.equal(commandStatusSchema.safeParse({ id: 'J/p', state: 'accepted', accepted_at: '2026-09-01T14:22:31.220Z' }).success, true)
        assert.equal(commandStatusSchema.safeParse({ id: 'J/p', state: 'executing' }).success, false)
    })
    it('rejected requires rejected_at and a rejection code, and forbids corrected_position', () => {
        const rejected = {
            id: 'J/p',
            state: 'rejected',
            rejected_at: '2026-09-01T14:22:31.220Z',
            error: { code: 'DESTINATION_UNREACHABLE', message: '340 m from the nearest drivable segment' },
            correction_distance_m: 340,
        }
        assert.equal(commandStatusSchema.safeParse(rejected).success, true)
        assert.equal(commandStatusSchema.safeParse({ ...rejected, rejected_at: undefined }).success, false)
        assert.equal(
            commandStatusSchema.safeParse({ ...rejected, error: { code: 'DRIVER_ERROR', message: 'x' } }).success,
            false,
            'DRIVER_ERROR is not a contract code',
        )
        assert.equal(commandStatusSchema.safeParse({ ...rejected, corrected_position: { lat: 0, lng: 0 } }).success, false)
    })
    it('correction_distance_m on a rejection is only valid with DESTINATION_UNREACHABLE', () => {
        const rejected = {
            id: 'J/p',
            state: 'rejected',
            rejected_at: '2026-09-01T14:22:31.220Z',
            error: { code: 'BOT_BUSY', message: 'busy' },
            correction_distance_m: 3,
        }
        assert.equal(commandStatusSchema.safeParse(rejected).success, false)
    })
    it('a correction travels with accepted/executing and with nothing else', () => {
        const ok = {
            id: 'J/p',
            state: 'accepted',
            accepted_at: '2026-09-01T14:22:31.220Z',
            corrected_position: { lat: 33.9703, lng: -118.4146 },
            correction_distance_m: 28.9,
        }
        assert.equal(commandStatusSchema.safeParse(ok).success, true)
        assert.equal(commandStatusSchema.safeParse({ ...ok, state: 'executing' }).success, true)
        assert.equal(
            commandStatusSchema.safeParse({ ...ok, state: 'succeeded' }).success,
            false,
            'the page scopes corrected_position to accepted/executing',
        )
        assert.equal(
            commandStatusSchema.safeParse({
                id: 'J/p',
                state: 'accepted',
                accepted_at: '2026-09-01T14:22:31.220Z',
                correction_distance_m: 28.9,
            }).success,
            false,
            'a bare distance outside a DESTINATION_UNREACHABLE rejection has nothing to measure',
        )
    })
    it('failed carries an error with any code (it is the partner runtime failure, not a rejection)', () => {
        const failed = {
            id: 'J/p',
            state: 'failed',
            accepted_at: '2026-09-01T14:22:31.220Z',
            error: { code: 'MOTOR_FAULT', message: 'left wheel' },
        }
        assert.equal(commandStatusSchema.safeParse(failed).success, true)
    })
})

describe('fleetCapabilitiesSchema', () => {
    it('is the N2 shape: fleet flag, default, optional overrides', () => {
        const doc = {
            supports_command_interrupt: true,
            default: { has_door: true, supported_commands: ['navigate_to', 'cancel_navigation', 'set_door'] },
            overrides: { 'ACME-0143': { has_door: false, supported_commands: ['navigate_to', 'cancel_navigation'] } },
        }
        assert.equal(fleetCapabilitiesSchema.safeParse(doc).success, true)
        assert.equal(fleetCapabilitiesSchema.safeParse({ default: doc.default }).success, false, 'supports_command_interrupt is required')
    })
})

describe('problemDetailsSchema', () => {
    it('is RFC 7807 with the machine code in `code`, never in `title`', () => {
        const body = {
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            code: 'DESTINATION_UNREACHABLE',
            detail: '340 m away',
            correction_distance_m: 340,
        }
        const parsed = problemDetailsSchema.safeParse(body)
        assert.equal(parsed.success, true)
        assert.equal(parsed.success && parsed.data.code, 'DESTINATION_UNREACHABLE')
        assert.equal(problemDetailsSchema.safeParse({ title: 'X' }).success, false, 'status and code are required')
        assert.equal(
            problemDetailsSchema.safeParse({ type: 'about:blank', title: 'Unprocessable Entity', status: 422 }).success,
            false,
            'no code, no branching',
        )
    })
    it('keeps extensions remi adds (loose): the contract puts correction_distance_m outside the four RFC fields', () => {
        const parsed = problemDetailsSchema.safeParse({
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            code: 'BOT_ID_NOT_NAMESPACED',
            instance: '/api/v3/fleet/bots',
            future_field: 1,
        })
        assert.equal(parsed.success, true)
    })
})
