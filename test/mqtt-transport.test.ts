/**
 * The MQTT transport against a broker double.
 *
 * WHY A DOUBLE AND NOT AN IN-PROCESS BROKER: the kit connects with `protocolVersion: 5` and nothing
 * else (ruling R2), and `aedes` — which the plan named, and which this repo carried as a
 * devDependency until this task removed it — answers an MQTT 5 CONNECT with CONNACK return code 1,
 * "unacceptable protocol version", in 0.51.x and in 1.x alike (`lib/handlers/connect.js`:
 * `if (packet.protocolVersion < 3 || packet.protocolVersion > 4)`). Verified against the installed
 * 0.51.3 before a line of this file was written: every connection is refused, so an `aedes` suite
 * would assert the backoff path five times over and nothing else. Only `aedes@2.0.0-beta.1` (branch
 * `mqttv5`) speaks MQTT 5, and a repo partners clone should not depend on a beta broker. Do not
 * re-add it expecting MQTT 5.
 *
 * So the transport's own injection point takes the broker's place, and everything below the wire is
 * asserted here: client ids, QoS, retain flags, the command subscription, the ACL/credential/
 * protocol split, the link policy, the backoff and the recovery. The wire itself — a real MQTT 5
 * CONNECT, a retained state seen by a late subscriber, a real drop and reconnect — is covered by
 * `mqtt-broker.test.ts`, which runs against a real broker when `EFK_MQTT_URL` is set.
 */
import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import type { BotEvent, BotState } from '../src/contract/schemas'
import { fleetClientId, fleetTopic } from '../src/contract/topics'
import type { BotRuntime } from '../src/core/bot-runtime'
import { createEventBus, type KitEvents } from '../src/core/events'
import { FakeClock, FakeDriver } from '../src/core/fakes'
import { createMqttTransport } from '../src/transport/mqtt'
import type { MqttConnection, MqttConnectionOptions } from '../src/transport/mqtt/connection'
import { SubscriptionDeniedError } from '../src/transport/mqtt/connection'

const NS = 'acme'

type Sent = { topic: string; payload: unknown; qos: 0 | 1 | 2; retain: boolean }

/** What the double does to the connections opened from now on. */
type BrokerPolicy = { failConnect?: unknown; denySubscribe?: boolean; grantedQos?: number; denyPublishTo?: string }

class FakeConnection implements MqttConnection {
    ends = 0
    failEnd: Error | null = null
    readonly sent: Sent[] = []
    readonly subscribed: Array<{ topic: string; qos: 0 | 1 | 2 }> = []
    private connected = false
    private readonly handlers: Array<{ topic: string; handler: (topic: string, payload: string) => void }> = []

    constructor(
        readonly options: MqttConnectionOptions,
        private readonly policy: () => BrokerPolicy,
    ) {}

    async connect() {
        const failure = this.policy().failConnect
        if (failure) throw failure
        this.connected = true
    }

    async publish(topic: string, payload: unknown, { qos, retain }: { qos: 0 | 1 | 2; retain: boolean }) {
        if (!this.connected) throw new Error('not connected')
        if (this.policy().denyPublishTo === topic) throw new Error(`not authorized to publish to ${topic}`)
        this.sent.push({ topic, payload, qos, retain })
    }

    async subscribe(topic: string, qos: 0 | 1 | 2, handler: (topic: string, payload: string) => void) {
        if (!this.connected) throw new Error('not connected')
        if (this.policy().denySubscribe) throw new SubscriptionDeniedError(topic)
        this.subscribed.push({ topic, qos })
        this.handlers.push({ topic, handler })
        return { grantedQos: this.policy().grantedQos ?? qos }
    }

    async end() {
        this.connected = false
        if (this.failEnd) throw this.failEnd
        this.ends += 1
    }

    isConnected() {
        return this.connected
    }

    /** The broker hangs up. Nobody calls `end()` — that is the whole point: the slot keeps a dead object. */
    drop() {
        this.connected = false
    }

    /** Delivery the way the real wrapper does it: only to a handler registered for that exact topic. */
    deliver(topic: string, payload: string) {
        for (const entry of this.handlers) if (entry.topic === topic) entry.handler(topic, payload)
    }

    /** Delivery the wrapper would filter out, to reach the transport's own topic check (ruling R24b). */
    deliverRaw(topic: string, payload: string) {
        for (const entry of this.handlers) entry.handler(topic, payload)
    }
}

class FakeBroker {
    readonly connections: FakeConnection[] = []
    policy: BrokerPolicy = {}
    readonly factory = (options: MqttConnectionOptions): MqttConnection => {
        const connection = new FakeConnection(options, () => this.policy)
        this.connections.push(connection)
        return connection
    }

    get live(): FakeConnection[] {
        return this.connections.filter((connection) => connection.isConnected())
    }

    clientIds(): string[] {
        return this.live.map((connection) => connection.options.clientId)
    }

    /** The bot's CURRENT connection: a reconnect opens a new object and leaves the dead one in the list. */
    for(botId: string): FakeConnection {
        const clientId = fleetClientId(NS, botId)
        const connection = this.live.find((candidate) => candidate.options.clientId === clientId)
        assert.ok(connection, `no live connection for ${botId}`)
        return connection
    }
}

/** The transport needs a bot id, a snapshot (link policy), `touch()` (recovery) and a command handler. */
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

const event = (botId: string): BotEvent => ({ bot_id: botId, type: 'arrived', command_id: 'J/p', occurred_at: new Date().toISOString() })

/**
 * Every transport here is stopped through `t.after`, not only at the end of the test body: `start()`
 * arms a reconcile interval, and an assertion that fails before a manual `stop()` would leave that
 * timer holding the event loop open — a whole test run that hangs with no output instead of
 * reporting the failure it found.
 */
function setup(t: TestContext, botIds: string[]) {
    const broker = new FakeBroker()
    const bus = createEventBus()
    const clock = new FakeClock()
    const logs: Array<KitEvents['log']> = []
    const links: Array<KitEvents['link.changed']> = []
    bus.on('log', (entry) => logs.push(entry))
    bus.on('link.changed', (entry) => links.push(entry))
    const runtimes = botIds.map((botId) => new TestRuntime(new FakeDriver(botId)))
    const transport = createMqttTransport({
        namespace: NS,
        url: 'mqtts://broker.invalid:8883',
        username: `fleet_${NS}`,
        password: 'secret',
        bus,
        now: clock.now,
        random: () => 0.5, // neutral jitter: the backoff is exactly 1 s, 2 s, 4 s …
        connectionFactory: broker.factory,
        reconcileMs: 60_000, // this file drives reconcile() itself; the timer must not race it
    })
    const start = () => transport.start(runtimes as unknown as BotRuntime[])
    t.after(() => transport.stop())
    return { broker, bus, clock, logs, links, runtimes, transport, start, messages: () => logs.map((entry) => entry.message) }
}

describe('mqtt transport', () => {
    it('opens one connection per bot with the contract client id and subscribes to its command topic at QoS 1', async (t) => {
        const { broker, links, start } = setup(t, ['ACME-0001', 'ACME-0002'])
        await start()

        assert.deepEqual(broker.clientIds().sort(), [fleetClientId(NS, 'ACME-0001'), fleetClientId(NS, 'ACME-0002')])
        assert.deepEqual(broker.for('ACME-0001').subscribed, [{ topic: fleetTopic(NS, 'ACME-0001', 'command'), qos: 1 }])
        assert.deepEqual(broker.for('ACME-0002').subscribed, [{ topic: fleetTopic(NS, 'ACME-0002', 'command'), qos: 1 }])
        assert.deepEqual(
            links.map((link) => [link.botId, link.connected]),
            [
                ['ACME-0001', true],
                ['ACME-0002', true],
            ],
        )
    })

    it('retains state, does not retain events', async (t) => {
        const { broker, start, transport } = setup(t, ['ACME-0001', 'ACME-0002'])
        await start()
        const botState = state('ACME-0001')
        const botEvent = event('ACME-0001')

        assert.equal(await transport.publishState('ACME-0001', botState), true)
        assert.equal(await transport.publishEvent('ACME-0001', botEvent), true)

        assert.deepEqual(broker.for('ACME-0001').sent, [
            { topic: fleetTopic(NS, 'ACME-0001', 'state'), payload: botState, qos: 1, retain: true },
            { topic: fleetTopic(NS, 'ACME-0001', 'event'), payload: botEvent, qos: 1, retain: false },
        ])
        assert.deepEqual(broker.for('ACME-0002').sent, [], 'each bot publishes on its own connection only')
    })

    it('a command on the bot topic reaches the handler; an invalid or foreign one costs a log line instead', async (t) => {
        const { broker, messages, start, transport } = setup(t, ['ACME-0001'])
        const received: string[] = []
        transport.onCommand(async (botId, command) => {
            received.push(`${botId}:${command.id}`)
            return { kind: 'accepted', status: { id: command.id, state: 'accepted', accepted_at: new Date().toISOString() } }
        })
        await start()
        const connection = broker.for('ACME-0001')
        const command = JSON.stringify({
            id: 'J/pickup',
            type: 'navigate_to',
            params: { lat: 0, lng: 0 },
            issued_at: new Date().toISOString(),
        })

        connection.deliver(fleetTopic(NS, 'ACME-0001', 'command'), command)
        assert.deepEqual(received, ['ACME-0001:J/pickup'])

        connection.deliver(fleetTopic(NS, 'ACME-0001', 'command'), JSON.stringify({ id: 'J/x', type: 'teleport', params: {} }))
        assert.deepEqual(received, ['ACME-0001:J/pickup'], 'a command that does not validate never reaches the runtime')
        assert.match(messages().join('\n'), /did not validate/)

        // Ruling R24b: the topic is parsed with the contract's parser, so a message the broker put
        // somewhere else — a widened subscription, a retained payload on a neighbour's topic — is
        // recognised as not this bot's and dropped.
        connection.deliverRaw(fleetTopic('other_partner', 'GW-1', 'command'), command)
        assert.deepEqual(received, ['ACME-0001:J/pickup'])
        assert.match(messages().join('\n'), /is not this bot's command topic/)
    })

    it('a refused CONNECT backs off instead of looping, and prints the credential remedy once', async (t) => {
        const { broker, clock, logs, messages, start, transport } = setup(t, ['ACME-0001'])
        broker.policy.failConnect = new Error('Connection refused: Not authorized')
        const failures = () => messages().filter((message) => message.startsWith('CONNECT failed'))
        await start()

        assert.equal(failures().length, 1)
        assert.match(failures()[0] ?? '', /retrying in 1000 ms/)
        assert.match(failures()[0] ?? '', /MQTT_USERNAME\/MQTT_PASSWORD/)
        assert.match(failures()[0] ?? '', /banned for a few minutes/)
        assert.equal(logs[0]?.level, 'error')
        assert.equal(await transport.publishState('ACME-0001', state('ACME-0001')), false)

        await transport.reconcile()
        await transport.reconcile()
        clock.advance(999)
        await transport.reconcile()
        assert.equal(failures().length, 1, 'the retry waits out the whole second, however often reconcile runs')

        clock.advance(1)
        await transport.reconcile()
        assert.equal(failures().length, 2)
        assert.match(failures()[1] ?? '', /retrying in 2000 ms/, 'and the wait doubles')
        assert.equal(logs.at(-1)?.level, 'warn', 'only the first failure shouts')
        assert.deepEqual(broker.live, [], 'a refused CONNECT leaves nothing half-open')
        assert.equal(
            broker.connections.filter((connection) => connection.ends === 1).length,
            2,
            'and each attempt was closed before the next one',
        )
    })

    it('a CONNECT refused over the protocol version says so on every attempt and never blames the credential', async (t) => {
        const { broker, clock, logs, messages, start, transport } = setup(t, ['ACME-0001'])
        // What mqtt.js raises for an MQTT 5 CONNACK 0x84 …
        broker.policy.failConnect = Object.assign(new Error('Connection refused: Unsupported Protocol Version'), { code: 132 })
        await start()
        // … and for the 3.1.1 CONNACK return code 1 a broker may answer with instead.
        broker.policy.failConnect = Object.assign(new Error('Connection refused: Unacceptable protocol version'), { code: 1 })
        clock.advance(1_000)
        await transport.reconcile()

        const refusals = logs.filter((entry) => entry.message.startsWith('CONNECT refused over the protocol version'))
        assert.equal(refusals.length, 2, 'both CONNACK spellings are recognised')
        assert.deepEqual(
            refusals.map((entry) => entry.level),
            ['error', 'error'],
            'it never fades into a silent retry loop',
        )
        assert.match(refusals[0]?.message ?? '', /MQTT 5 only and does not fall back to 3\.1\.1/)
        assert.match(refusals[0]?.message ?? '', /EMQX 5/)
        assert.match(refusals[0]?.message ?? '', /retrying in 1000 ms/)
        assert.doesNotMatch(messages().join('\n'), /MQTT_USERNAME\/MQTT_PASSWORD/, 'the credential is fine; the broker is the problem')
    })

    /**
     * Controller ruling: no path a user can see may forward the raw message of an mqtt.js exception.
     * The classifier is pinned against a real mqtt.js throw in `src/transport/mqtt/failure.test.ts`;
     * this pins the CALL SITE, which is the half that regresses when someone reaches for
     * `error.message` again because it is right there.
     */
    it('never puts the text of an mqtt.js exception into the log, however much it carries', async (t) => {
        const { broker, messages, start } = setup(t, ['ACME-0001'])
        // The shape mqtt.js produces for a refused CONNECT, carrying what such a message can carry.
        broker.policy.failConnect = Object.assign(new Error('Connection refused: Not authorized (user=fleet_acme password=hunter2)'), {
            code: 5,
        })
        await start()

        const log = messages().join('\n')
        assert.ok(!log.includes('hunter2'), `the broker password must not reach the log: ${log}`)
        assert.ok(!log.includes('Connection refused:'), "and neither does mqtt.js's own phrasing")
        assert.match(log, /CONNECT failed \(not authorised/, 'it is described in the kit’s words instead')
        assert.match(log, /MQTT_USERNAME\/MQTT_PASSWORD/, 'and the credential remedy still fires, which is what the phrase gates')
    })

    it('a denied SUBSCRIBE is reported as an ACL problem, not as a bad credential', async (t) => {
        const { broker, messages, start, transport } = setup(t, ['ACME-0001'])
        broker.policy.denySubscribe = true
        await start()

        assert.match(messages().join('\n'), /refused the command subscription/)
        assert.match(messages().join('\n'), /fleet\/acme\/bot\/\+\/command/)
        assert.doesNotMatch(
            messages().join('\n'),
            /MQTT_USERNAME\/MQTT_PASSWORD/,
            'the credential is fine; sending the partner to check it would waste their afternoon',
        )
        assert.deepEqual(broker.live, [], 'the connection that cannot hear commands is closed, not kept')
        assert.equal(await transport.publishState('ACME-0001', state('ACME-0001')), false)
    })

    it('a downgraded command subscription is a warning, not a failure', async (t) => {
        const { broker, messages, start, transport } = setup(t, ['ACME-0001'])
        broker.policy.grantedQos = 0
        await start()

        assert.match(messages().join('\n'), /broker granted QoS 0 on the command topic; commands may be lost/)
        assert.equal(broker.live.length, 1, 'a downgrade is not a denial: the link stays up')
        assert.equal(await transport.publishState('ACME-0001', state('ACME-0001')), true)
    })

    it('closes the connection for real when the driver goes offline, and publishState says nothing left', async (t) => {
        const { broker, links, runtimes, start, transport } = setup(t, ['ACME-0001'])
        await start()
        const first = broker.for('ACME-0001')
        const runtime = runtimes[0]!

        runtime.driver.snap = { ...runtime.driver.snap, connected: false }
        await transport.reconcile()
        assert.equal(first.ends, 1)
        assert.deepEqual(broker.live, [])
        assert.equal(await transport.publishState('ACME-0001', state('ACME-0001')), false)
        assert.deepEqual(links.at(-1), { botId: 'ACME-0001', connected: false, reason: 'link policy' })

        // Coming back is not a failure, so it does not wait out a backoff.
        runtime.driver.snap = { ...runtime.driver.snap, connected: true }
        await transport.reconcile()
        assert.equal(broker.live.length, 1)
        assert.deepEqual(links.at(-1), { botId: 'ACME-0001', connected: true })
    })

    it('recovers from a drop: it notices, backs off once, and reconnects (ruling R3)', async (t) => {
        const { broker, clock, links, messages, start, transport } = setup(t, ['ACME-0001'])
        await start()
        const first = broker.for('ACME-0001')
        assert.equal(await transport.publishState('ACME-0001', state('ACME-0001')), true)

        // The broker hangs up: the slot still holds a connection object, and nothing else notices.
        first.drop()
        assert.equal(
            await transport.publishState('ACME-0001', state('ACME-0001')),
            false,
            'a dead connection never reports a publish as delivered',
        )
        assert.equal(await transport.publishEvent('ACME-0001', event('ACME-0001')), false)
        assert.equal(first.sent.length, 1, 'and nothing was handed to it either')

        await transport.reconcile()
        assert.deepEqual(links.at(-1), { botId: 'ACME-0001', connected: false, reason: 'connection lost' })
        assert.match(messages().at(-1) ?? '', /the connection dropped; reconnecting in 1000 ms/)
        assert.equal(first.ends, 1, 'the dead connection is closed, not leaked')

        await transport.reconcile()
        clock.advance(999)
        await transport.reconcile()
        assert.equal(broker.connections.length, 1, 'the reconnect waits out the backoff: no tight loop')

        clock.advance(1)
        await transport.reconcile()
        assert.equal(broker.connections.length, 2)
        assert.deepEqual(links.at(-1), { botId: 'ACME-0001', connected: true })
        const second = broker.for('ACME-0001')
        assert.notEqual(second, first)
        assert.deepEqual(second.subscribed, [{ topic: fleetTopic(NS, 'ACME-0001', 'command'), qos: 1 }], 'commands flow again')
        assert.equal(await transport.publishState('ACME-0001', state('ACME-0001')), true)
    })

    it('a reconnect calls touch(), so a recovered bot does not wait out the 15 s heartbeat', async (t) => {
        const { broker, clock, runtimes, start, transport } = setup(t, ['ACME-0001'])
        await start()
        const runtime = runtimes[0]!
        assert.equal(runtime.touches, 1)

        broker.for('ACME-0001').drop()
        await transport.reconcile()
        clock.advance(1_000)
        await transport.reconcile()

        assert.equal(broker.live.length, 1, 'it reconnected')
        assert.equal(runtime.touches, 2, 'and marked the snapshot dirty, so the next 250 ms tick publishes')
    })

    it('holds one connection per bot on a 200-bot roster, and stop() closes every one', async (t) => {
        const ids = Array.from({ length: 200 }, (_, index) => `ACME-${String(index + 1).padStart(4, '0')}`)
        const { broker, messages, start, transport } = setup(t, ids)
        await start()

        assert.equal(broker.live.length, 200)
        assert.equal(new Set(broker.clientIds()).size, 200, 'one client id per bot, all distinct')

        // One connection refuses to close. The other 199 must still be closed, not stranded behind it.
        // The failure carries text of the kind mqtt.js can build out of its connect options, so the
        // report is CONSTRUCTED (controller ruling) — it still says which bot and what happened, and
        // quotes none of the exception.
        broker.for('ACME-0100').failEnd = new Error('socket already gone for fleet_acme:hunter2')
        await transport.stop()

        assert.deepEqual(broker.live, [])
        assert.equal(broker.connections.filter((connection) => connection.ends === 1).length, 199)
        const log = messages().join('\n')
        assert.match(log, /closing the connection failed: Error, with no code this kit can safely quote/)
        assert.ok(!log.includes('hunter2'), 'and the exception text does not ride along')
        assert.ok(!log.includes('socket already gone'))
        assert.equal(await transport.publishState('ACME-0001', state('ACME-0001')), false)
    })
})
