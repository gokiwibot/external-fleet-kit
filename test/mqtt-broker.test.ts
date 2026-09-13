/**
 * Opt-in wire test: the REAL mqtt.js connection against a REAL MQTT 5 broker.
 *
 * It runs only when `EFK_MQTT_URL` points at one, and skips otherwise, so `pnpm test` on a bare clone
 * still needs no infrastructure and CI stays green until a broker service is wired into the workflow.
 *
 *     EFK_MQTT_URL=mqtt://127.0.0.1:1884 pnpm test
 *
 * There is no in-process alternative, and this is the note for whoever reaches for one: `aedes` —
 * which this repo used to carry as a devDependency and which was removed for exactly this reason —
 * answers an MQTT 5 CONNECT with return code 1, "unacceptable protocol version", in 0.51.x and in
 * 1.x alike (`lib/handlers/connect.js`: `packet.protocolVersion > 4`). Only the 2.0.0 beta speaks
 * MQTT 5, and a beta broker is not something a repo partners clone should depend on. Everything that
 * does not need a wire is covered by the broker double in `mqtt-transport.test.ts`.
 *
 * NEVER point `EFK_MQTT_URL` at port 1883 on a developer machine (a RabbitMQ with no MQTT 5 shared
 * subscriptions: the run hangs for minutes and looks exactly like a code failure) and never at
 * `mqtt.kiwibot.com`, which is production. The test refuses both rather than trusting the operator.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import mqtt from 'mqtt'
import type { BotState } from '../src/contract/schemas'
import { fleetClientId, fleetTopic } from '../src/contract/topics'
import type { BotRuntime } from '../src/core/bot-runtime'
import { createEventBus } from '../src/core/events'
import { FakeClock, FakeDriver } from '../src/core/fakes'
import { createMqttTransport } from '../src/transport/mqtt'

const URL = process.env.EFK_MQTT_URL
const NS = 'acme'
/** A bot id of this run only: two runs against the same broker must not fight over one session. */
const BOT_ID = `EFK-TEST-${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')}`

/**
 * The port mqtt.js will actually dial. `new URL('mqtt://127.0.0.1').port` is the EMPTY STRING, and
 * mqtt.js then connects to 1883 regardless — so comparing `parsed.port` to '1883' lets the most
 * natural spelling of the URL walk straight past the rail and into the broker it exists to keep the
 * suite away from. The scheme's default is resolved first, and an unknown scheme with no explicit
 * port is refused rather than guessed: what it would dial is exactly what we cannot tell.
 */
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'mqtt:': '1883', 'mqtts:': '8883', 'ws:': '80', 'wss:': '443' }

function brokerPort(parsed: globalThis.URL): string {
    if (parsed.port) return parsed.port
    const fallback = DEFAULT_PORTS[parsed.protocol]
    assert.ok(
        fallback,
        `refusing ${parsed.protocol}//${parsed.host}: unknown scheme with no explicit port, so the port it would dial is unknown`,
    )
    return fallback
}

function assertSafeBroker(url: string) {
    const parsed = new globalThis.URL(url)
    // Production first: it is the graver mistake, and it deserves to be named whatever port it is on.
    assert.ok(!/kiwibot\.com$/i.test(parsed.hostname), `refusing ${parsed.hostname}: that is production, not a test broker`)
    assert.notEqual(
        brokerPort(parsed),
        '1883',
        'refusing port 1883: on a dev machine that is a broker without MQTT 5, and the run would hang',
    )
}

class TestRuntime {
    touches = 0
    constructor(readonly driver: FakeDriver) {}
    get botId() {
        return this.driver.botId
    }
    snapshot() {
        return this.driver.snapshot()
    }
    touch() {
        this.touches += 1
    }
    async handleCommand() {
        return { kind: 'accepted' as const, status: { id: 'x', state: 'accepted' as const, accepted_at: new Date().toISOString() } }
    }
}

const state = (botId: string): BotState => ({
    bot_id: botId,
    seq: 1,
    timestamp: new Date().toISOString(),
    available: true,
    connected: true,
    position: { lat: 0, lng: 0 },
    battery: { percentage: 80 },
    door: 'closed',
    current_command: null,
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls a condition with a deadline, so a broker that never answers reports a failure instead of hanging the run. */
async function within(ms: number, label: string, condition: () => Promise<boolean> | boolean) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
        if (await condition()) return
        await sleep(50)
    }
    assert.fail(`timed out after ${ms} ms waiting for ${label}`)
}

/**
 * The rail on the rail. It runs whether or not a broker is configured, because the spelling it
 * refuses is the one somebody types the first time they enable this file — and by then the guard is
 * the only thing between the run and a broker that hangs it for minutes with no output.
 */
describe('EFK_MQTT_URL guard', () => {
    it('refuses port 1883 however it is spelled, including not at all', () => {
        const refused = /refusing port 1883/
        // Explicit …
        assert.throws(() => assertSafeBroker('mqtt://127.0.0.1:1883'), refused)
        // … and implied, which is how anyone would actually type it.
        assert.throws(() => assertSafeBroker('mqtt://127.0.0.1'), refused)
        assert.throws(() => assertSafeBroker('mqtt://localhost'), refused)
        assert.throws(() => assertSafeBroker('ws://127.0.0.1:1883'), refused, 'the check is on the port, not on the scheme')
        assert.equal(brokerPort(new globalThis.URL('mqtt://127.0.0.1')), '1883', 'an empty port is not "no port": mqtt.js dials 1883')
    })

    it('refuses production, and an unknown scheme whose port cannot be known', () => {
        assert.throws(() => assertSafeBroker('mqtts://mqtt.kiwibot.com:8883'), /that is production/)
        assert.throws(() => assertSafeBroker('mqtt://mqtt.kiwibot.com'), /that is production/)
        assert.throws(() => assertSafeBroker('tcp://127.0.0.1'), /unknown scheme with no explicit port/)
    })

    it('accepts a local MQTT 5 broker on another port, and the contract default over TLS', () => {
        assert.doesNotThrow(() => assertSafeBroker('mqtt://127.0.0.1:1884'))
        assert.doesNotThrow(() => assertSafeBroker('mqtts://broker.example.com'))
        assert.doesNotThrow(() => assertSafeBroker('wss://broker.example.com'))
        assert.equal(brokerPort(new globalThis.URL('mqtts://broker.example.com')), '8883')
    })
})

/**
 * `timeout` sits on the SUITE so every test in the file inherits it: node's default is `Infinity`,
 * and a bound that has to be remembered on each `it` is one the next test added here will not have.
 */
describe('mqtt transport against a real broker', {
    skip: URL ? false : 'set EFK_MQTT_URL to run (e.g. mqtt://127.0.0.1:1884)',
    timeout: 30_000,
}, () => {
    it('connects, retains state, and recovers from a drop with a reconnect that calls touch()', { timeout: 30_000 }, async (t) => {
        const url = URL ?? ''
        assertSafeBroker(url)

        const bus = createEventBus()
        const clock = new FakeClock()
        const logs: string[] = []
        const links: Array<{ botId: string; connected: boolean; reason?: string }> = []
        bus.on('log', (entry) => logs.push(entry.message))
        bus.on('link.changed', (entry) => links.push(entry))
        const runtime = new TestRuntime(new FakeDriver(BOT_ID))
        const transport = createMqttTransport({
            namespace: NS,
            url,
            username: `fleet_${NS}`,
            password: 'secret',
            bus,
            now: clock.now,
            random: () => 0.5, // the backoff is exactly 1 s, and the clock below is the one that moves
            reconcileMs: 60_000, // this test drives reconcile() itself
        })
        const stateTopic = fleetTopic(NS, BOT_ID, 'state')
        const observer = await mqtt.connectAsync(url, { clientId: `fleet-${NS}-observer-${BOT_ID}-hb`, protocolVersion: 5, clean: true })
        /** Declared here so the cleanup owns it: a test that fails before ending it would otherwise leave an open socket holding the whole run. */
        let thief: mqtt.MqttClient | null = null
        t.after(async () => {
            await thief?.endAsync().catch(() => {})
            await transport.stop()
            // Leave the broker as it was found: a retained state outlives the process that published it.
            await observer.publishAsync(stateTopic, '', { qos: 1, retain: true }).catch(() => {})
            await observer.endAsync().catch(() => {})
        })

        /**
         * Publishes one state, and never lets the run hang on it: a QoS 1 publish issued in the gap
         * between a broker-side drop and mqtt.js noticing waits for a PUBACK that is never coming, so
         * a bare `await` here would stall the whole file with no output. In the kit that promise is
         * settled by the `end()` inside reconcile(), at most `reconcileMs` later.
         */
        const published = async (label: string) => {
            const outcome = await Promise.race([
                transport.publishState(BOT_ID, state(BOT_ID)).catch(() => false),
                sleep(5_000).then(() => 'pending' as const),
            ])
            assert.notEqual(outcome, 'pending', `the publish ${label} never settled`)
            return outcome === true
        }

        // 1. A real MQTT 5 CONNECT, and a state that really leaves the process.
        await transport.start([runtime] as unknown as BotRuntime[])
        assert.equal(logs.join('\n'), '', 'a clean connect logs nothing')
        assert.equal(await published('on a healthy link'), true)
        assert.equal(runtime.touches, 1)

        // 2. A LATE subscriber gets the state because it was published retained.
        const retained: string[] = []
        observer.on('message', (topic, _payload, packet) => {
            if (packet.retain) retained.push(topic)
        })
        await observer.subscribeAsync(`fleet/${NS}/bot/${BOT_ID}/#`, { qos: 1 })
        await within(5_000, 'the retained state to reach a late subscriber', () => retained.includes(stateTopic))

        // 3. A REAL drop, with no clean `end()` on our side: another client takes the bot's session and
        //    the broker kicks ours. This is what a broker restart or a network drop looks like to the kit.
        thief = await mqtt.connectAsync(url, { clientId: fleetClientId(NS, BOT_ID), protocolVersion: 5, clean: true })
        await within(10_000, 'the transport to notice the drop', async () => {
            // reconcile() is the production path AND the only safe detector here: asking the dead
            // client to publish instead would issue a QoS 1 publish in the window between the broker
            // dropping the link and mqtt.js noticing, and mqtt.js never settles that promise until
            // something calls `end()` — which is exactly what reconcile() does.
            await transport.reconcile()
            return links.some((link) => !link.connected)
        })
        await thief.endAsync()
        thief = null
        assert.deepEqual(links.at(-1), { botId: BOT_ID, connected: false, reason: 'connection lost' })
        assert.match(logs.join('\n'), /the connection dropped; reconnecting in 1000 ms/)

        // 4. The transport waits out the backoff and only then reconnects.
        assert.equal(await published('while the link is down'), false, 'a dropped link never reports a publish as delivered')
        await transport.reconcile()
        assert.equal(await published('inside the backoff window'), false)

        clock.advance(1_000)
        await transport.reconcile()
        await within(10_000, 'the transport to reconnect and publish again', () => published('after the reconnect'))
        assert.equal(runtime.touches, 2, 'the reconnect marked the snapshot dirty')
    })
})
