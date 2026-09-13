import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadEnv } from './env'

const base = {
    REMI_API_URL: 'https://remi.kiwi',
    REMI_API_KEY: `live_sk_${'0'.repeat(48)}`,
    REMI_TRANSPORT: 'mqtt',
    MQTT_HOST: 'mqtt.example.invalid',
    MQTT_USERNAME: 'fleet_acme',
    MQTT_PASSWORD: 'x',
    SANDBOX_LOCATION_ID: 'V1StGXR8Z5jdHi6BmyT2q',
    SANDBOX_CENTER_LAT: '33.9701',
    SANDBOX_CENTER_LNG: '-118.4148',
}

describe('.env', () => {
    it('parses the canonical mqtt bundle with defaults', () => {
        const r = loadEnv(base)
        assert.equal(r.ok, true)
        if (!r.ok) return
        assert.equal(r.env.MQTT_PORT, 8883)
        assert.equal(r.env.WEB_PORT, 4310)
        assert.equal(r.env.SANDBOX_PICKUP_EXTERNAL_ID, 'efk-sandbox-pickup')
        assert.equal(r.env.SANDBOX_CENTER_LAT, 33.9701)
    })
    it('an empty MQTT_PASSWORD parses: that is the state of the .env as delivered', () => {
        // The password arrives out of band, so the file is valid with the line present and empty.
        // Reporting it belongs to `efk check` C1, which can say WHERE to get the value.
        const r = loadEnv({ ...base, MQTT_PASSWORD: '' })
        assert.equal(r.ok, true)
        assert.equal(r.ok && r.env.MQTT_PASSWORD, '')
        assert.equal(loadEnv({ ...base, MQTT_HOST: '' }).ok, false, 'the variables that are NOT delivered out of band are still required')
    })
    it('EFK_SCENARIO defaults to default and is part of the schema', () => {
        const plain = loadEnv(base)
        const named = loadEnv({ ...base, EFK_SCENARIO: 'low-battery' })
        assert.equal(plain.ok ? plain.env.EFK_SCENARIO : null, 'default')
        assert.equal(named.ok ? named.env.EFK_SCENARIO : null, 'low-battery')
    })
    it('http requires token and https public url', () => {
        const r = loadEnv({ ...base, REMI_TRANSPORT: 'http', HTTP_TOKEN: 'a'.repeat(32), HTTP_PUBLIC_URL: 'http://fleet.acme.test' })
        assert.equal(r.ok, false)
        assert.match(!r.ok ? r.error : '', /https/)
    })
    it('rejects a malformed key', () => {
        assert.equal(loadEnv({ ...base, REMI_API_KEY: 'live_sk_short' }).ok, false)
    })
    /**
     * The error string is printed verbatim by `efk check` C1, and every variable in this file is or
     * contains a credential. It must name the VARIABLE and never quote its value.
     */
    it('the error names the variable, never the value', () => {
        const r = loadEnv({ ...base, REMI_API_KEY: 'live_sk_notactuallyhexbutlongenoughtolooklikeasecret' })
        assert.equal(r.ok, false)
        if (r.ok) return
        assert.match(r.error, /REMI_API_KEY/)
        assert.ok(!r.error.includes('notactuallyhex'), `the key value leaked into the error: ${r.error}`)
    })
})
