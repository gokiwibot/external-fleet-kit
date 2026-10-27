/**
 * As with `net-failure.test.ts`, the shape under test is one mqtt.js REALLY produced — captured by
 * connecting to a closed local port — rather than an Error someone imagined it would throw.
 *
 * Never port 1883: that is RabbitMQ on this machine and it does not speak the MQTT 5 the kit needs,
 * so a connection there hangs for minutes and says nothing. Never a real broker.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import mqtt from 'mqtt'
import { describeMqttFailure, isProtocolVersionRejection } from './failure'

const CLOSED = 45_999

describe('describeMqttFailure, against an exception mqtt.js really threw', () => {
    it('describes a refused connection from the code, and quotes nothing of the connect options', async () => {
        let thrown: unknown = null
        try {
            await mqtt.connectAsync(`mqtt://127.0.0.1:${CLOSED}`, {
                protocolVersion: 5,
                connectTimeout: 5_000,
                reconnectPeriod: 0,
                username: 'fleet_acme',
                password: 'hunter2',
            })
        } catch (error) {
            thrown = error
        }
        assert.ok(thrown, 'precondition: mqtt.js rejects against a closed port')
        assert.equal(describeMqttFailure(thrown), 'the host refused the connection (ECONNREFUSED)')
    })

    it('never forwards a message that carries the broker password', () => {
        // mqtt.js and its transports compose messages from the connect options on several paths.
        const leaky = Object.assign(new Error('Connection refused: Not authorized (username=fleet_acme password=hunter2)'), { code: 5 })
        const described = describeMqttFailure(leaky)
        assert.ok(!described.includes('hunter2'), `the password must not survive: ${described}`)
        assert.ok(!described.includes('fleet_acme'))
        assert.match(described, /not authori/i, "and C5's credential branch still finds the word it looks for")
    })

    it('keeps the "not authorised" phrase for every way a broker says no', () => {
        for (const code of [4, 5, 134, 135, 138]) {
            assert.match(describeMqttFailure(Object.assign(new Error('x'), { code })), /not authori/i, `reason code ${code}`)
        }
        assert.match(describeMqttFailure(new Error('Connection refused: Not authorized')), /not authori/i, 'and with no code at all')
    })

    it('does not call a network failure an authentication failure', () => {
        const described = describeMqttFailure(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8883'), { code: 'ECONNREFUSED' }))
        assert.doesNotMatch(described, /not authori/i, 'or C5 would print the credential remedy for a closed port')
    })

    it('recognises both CONNACK spellings of a protocol-version rejection', () => {
        // Moved here from `connection.ts` so the classification lives in one place; same behaviour.
        assert.equal(isProtocolVersionRejection(Object.assign(new Error('x'), { code: 132 })), true, 'MQTT 5, 0x84')
        assert.equal(isProtocolVersionRejection(Object.assign(new Error('x'), { code: 1 })), true, '3.1.1, return code 1')
        assert.equal(isProtocolVersionRejection(new Error('Connection refused: Unacceptable protocol version')), true)
        assert.equal(isProtocolVersionRejection(Object.assign(new Error('x'), { code: 5 })), false)
        const described = describeMqttFailure(Object.assign(new Error('x'), { code: 132 }))
        assert.match(described, /MQTT 5/)
        assert.doesNotMatch(described, /not authori/i, 'retrying with another password will never fix this one')
    })

    it('quotes nothing at all from an exception it cannot classify', () => {
        const described = describeMqttFailure(new Error('handshake failed for fleet_acme:hunter2@broker.internal'))
        assert.ok(!described.includes('hunter2'))
        assert.ok(!described.includes('broker.internal'))
        assert.equal(described, 'the connection failed with no code this kit can safely quote')
    })
})
