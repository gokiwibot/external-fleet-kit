import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fleetCapabilitiesTopic, fleetCheckClientId, fleetClientId, fleetTopic, parseCommandTopic } from './topics'

describe('topics and client ids', () => {
    it('builds the four topics of the contract', () => {
        assert.equal(fleetTopic('acme', 'ACME-0142', 'state'), 'fleet/acme/bot/ACME-0142/state')
        assert.equal(fleetTopic('acme', 'ACME-0142', 'event'), 'fleet/acme/bot/ACME-0142/event')
        assert.equal(fleetTopic('acme', 'ACME-0142', 'command'), 'fleet/acme/bot/ACME-0142/command')
        assert.equal(fleetCapabilitiesTopic('acme'), 'fleet/acme/capabilities')
    })

    it('builds the client id the broker binds to the credential', () => {
        assert.equal(fleetClientId('acme', 'ACME-0142'), 'fleet-acme-ACME-0142-hb')
    })

    it('builds a diagnostic client id that keeps the prefix and never collides with a bot', () => {
        const id = fleetCheckClientId('acme', () => 0.123456789)
        assert.ok(id.startsWith('fleet-acme-check-'))
        assert.ok(id.endsWith('-hb'))
        assert.notEqual(id, fleetClientId('acme', 'check'))
    })

    it('parses a command topic back into namespace and bot id, and rejects anything else', () => {
        assert.deepEqual(parseCommandTopic('fleet/acme/bot/ACME-0142/command'), { namespace: 'acme', botId: 'ACME-0142' })
        assert.equal(parseCommandTopic('fleet/acme/bot/ACME-0142/state'), null)
        assert.equal(parseCommandTopic('fleet/acme/capabilities'), null)
        assert.equal(parseCommandTopic('hardware/bot/4S001/remote/actions'), null)
        assert.equal(parseCommandTopic(`fleet/acme/bot/${'A'.repeat(65)}/command`), null, 'the length cap of the grammar applies here too')
    })
})
