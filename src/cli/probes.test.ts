/**
 * `efk check` C5 and C6 echo `probe.error` VERBATIM into the verdict a partner pastes into a
 * support email, so the probe — not the caller — is responsible for what that string contains. The
 * first probes returned `error.message` straight from mqtt.js and from `fetch`.
 *
 * The tests that matter here are the ones that hand a classifier a throw which REALLY carries a
 * credential. Asserting "no password appeared" after a plain connection failure proves nothing: the
 * password was never in that message to begin with, so the assertion would pass just as happily on
 * the forwarding version. Every leak test below starts from an exception that does contain a secret.
 *
 * Nothing here reaches the network: the two end-to-end probes point at a CLOSED port on 127.0.0.1
 * (never 1883, which is RabbitMQ on this machine, and never a real broker or a remi host).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeFetchFailure } from '../net-failure'
import { describeMqttFailure } from '../transport/mqtt/failure'
import { httpProbe, mqttProbe } from './probes'

/** A closed port that is a legal HTTP port — node rejects port 1 as "bad port" before it connects. */
const CLOSED = 45_999

describe('probe error sanitisation', () => {
    it('never forwards an mqtt exception that carries the broker password', () => {
        // mqtt.js and its transports build messages from connection options on several paths.
        const leaky = Object.assign(new Error('Connection refused: Not authorized (username=fleet_acme password=hunter2)'), { code: 5 })
        const described = describeMqttFailure(leaky)
        assert.ok(!described.includes('hunter2'), `the password must not survive: ${described}`)
        assert.ok(!described.includes('fleet_acme'), 'nor the rest of the quoted message')
        assert.match(described, /not authori/i, "and C5's credential branch still has the word it looks for")
    })

    it('keeps the "not authorised" discriminator for every way a broker says no', () => {
        // C5 chooses between the credential remedy and the network remedy on /not authori/i. If a
        // classification loses that phrase, a wrong password sends the partner to debug a firewall.
        for (const code of [4, 5, 134, 135, 138]) {
            assert.match(describeMqttFailure(Object.assign(new Error('x'), { code })), /not authori/i, `reason code ${code}`)
        }
        // And with no code at all, which is how mqtt.js reports some 3.1.1 refusals.
        assert.match(describeMqttFailure(new Error('Connection refused: Not authorized')), /not authori/i)
    })

    it('does not call a network failure an authentication failure', () => {
        const refused = describeMqttFailure(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8883'), { code: 'ECONNREFUSED' }))
        assert.doesNotMatch(refused, /not authori/i, 'or C5 would print the credential remedy for a closed port')
        assert.match(refused, /ECONNREFUSED/)
    })

    it('says the MQTT 5 rejection is not a password problem', () => {
        const described = describeMqttFailure(Object.assign(new Error('unsupported protocol version'), { code: 132 }))
        assert.match(described, /MQTT 5/)
        assert.doesNotMatch(described, /not authori/i, 'retrying with a different password will never fix this one')
    })

    it('quotes nothing at all from an exception it cannot classify', () => {
        const described = describeMqttFailure(new Error('tls handshake failed for fleet_acme:hunter2@broker.internal'))
        assert.ok(!described.includes('hunter2'))
        assert.ok(!described.includes('broker.internal'))
        assert.equal(described, 'the connection failed with no code this kit can safely quote')
    })

    /**
     * The live one. Node's `fetch` refuses a URL with userinfo and puts THE WHOLE URL — password
     * included — in the message. This is reproducible, not theoretical: it is what
     * `HTTP_PUBLIC_URL=https://user:pass@host` produces today.
     */
    it('never forwards the fetch exception that quotes a URL with credentials in it', () => {
        const real = new TypeError(
            'Request cannot be constructed from a URL that includes credentials: https://user:supersecret@fleet.acme.com/v1/bots',
        )
        const described = describeFetchFailure(real)
        assert.ok(!described.includes('supersecret'), `the password must not survive: ${described}`)
        assert.ok(!described.includes('fleet.acme.com'), 'and neither does the URL it was embedded in')
        assert.match(described, /take the credentials out of it/, 'while still naming the fix')
    })

    it('classifies a fetch failure from the cause, and quotes nothing else', () => {
        const failed = Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }),
        })
        assert.equal(describeFetchFailure(failed), 'the host refused the connection (ECONNREFUSED)')
        assert.equal(describeFetchFailure(Object.assign(new Error('t'), { name: 'TimeoutError' }), 5_000), 'no answer within 5 s')
    })
})

describe('probes end to end, against a closed local port', () => {
    it('mqttProbe reports a refused connection without connack, and leaves no client open', async () => {
        const result = await mqttProbe({
            url: `mqtt://127.0.0.1:${CLOSED}`,
            username: 'fleet_acme',
            password: 'hunter2',
            clientId: 'fleet-acme-check-0000000a-hb',
            commandTopicFilter: 'fleet/acme/bot/+/command',
        })
        assert.equal(result.connack, false)
        assert.equal(result.grantedQos, -1)
        assert.equal(result.error, 'the host refused the connection (ECONNREFUSED)')
        assert.ok(!JSON.stringify(result).includes('hunter2'), 'the password reaches nothing the caller can print')
    })

    it('httpProbe reports status 0 with a constructed reason, not the raw throw', async () => {
        const result = await httpProbe(`http://127.0.0.1:${CLOSED}/bots`, 'a-bearer-token-that-must-not-appear')
        assert.equal(result.status, 0)
        assert.equal(result.error, 'the host refused the connection (ECONNREFUSED)')
        assert.ok(!JSON.stringify(result).includes('a-bearer-token-that-must-not-appear'))
        assert.ok(!result.error?.includes('fetch failed'), 'the raw message is built over, not passed along')
    })
})
