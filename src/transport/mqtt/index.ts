/**
 * MQTT transport: one connection per bot with the contract's client id, retained state,
 * non-retained events, command subscription per bot, and exponential backoff with jitter on CONNECT
 * failures. A bot whose driver reports `connected: false` (link offline/flapping) has its connection
 * closed for real, so the broker — not a payload — tells remi it is gone.
 *
 * RECOVERY. `reconnectPeriod: 0` means mqtt.js never reconnects on its own, so a broker
 * restart, a kicked session or a network drop would otherwise leave a non-null, DEAD connection in
 * the slot: `publishState` would keep answering `true` for publishes that go nowhere and the backoff
 * would never run, because the only thing that opens a connection is a slot whose connection is
 * null. `reconcile()` therefore asks every live slot whether it is REALLY connected and treats a
 * dead one exactly like a refused CONNECT — end it, announce it, wait out the backoff — which is the
 * same path the design spec asks for on "a rejected CONNECT or a drop".
 */
import { type BotCommand, type BotEvent, type BotState, botCommandSchema } from '../../contract/schemas'
import { fleetClientId, fleetTopic, parseCommandTopic } from '../../contract/topics'
import type { BotRuntime } from '../../core/bot-runtime'
import type { CommandOutcome, EventBus } from '../../core/events'
import { describeThrown } from '../../net-failure'
import type { Transport } from '../transport'
import { nextBackoffMs } from './backoff'
import { createMqttConnection, type MqttConnection, type MqttConnectionOptions, SubscriptionDeniedError } from './connection'
import { describeMqttFailure, isProtocolVersionRejection } from './failure'

export type MqttTransportDeps = {
    namespace: string
    url: string
    username: string
    password: string
    bus: EventBus
    now: () => number
    random?: () => number
    /** Injected in tests to point at a broker double. */
    connectionFactory?: (options: MqttConnectionOptions) => MqttConnection
    /** How often to reconcile desired vs actual connections (link policy and recovery). */
    reconcileMs?: number
}

type Slot = {
    runtime: BotRuntime
    connection: MqttConnection | null
    attempt: number
    retryAt: number
    wants: () => boolean
    connecting: boolean
}

export function createMqttTransport(
    deps: MqttTransportDeps,
): Transport & { setLinkPolicy(botId: string, wants: () => boolean): void; reconcile(): Promise<void> } {
    const random = deps.random ?? Math.random
    const factory = deps.connectionFactory ?? createMqttConnection
    const slots = new Map<string, Slot>()
    let handler: ((botId: string, command: BotCommand) => Promise<CommandOutcome>) | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    const log = (level: 'info' | 'warn' | 'error', message: string, botId?: string) => deps.bus.emit('log', { level, message, botId })

    /** Arms the next attempt for this slot and answers how long it waits. Never a tight loop: the wait is at least 800 ms. */
    const scheduleRetry = (slot: Slot): number => {
        const wait = nextBackoffMs(slot.attempt, random)
        slot.attempt += 1
        slot.retryAt = deps.now() + wait
        return wait
    }

    /** The connection of a bot only if it is REALLY up: a dropped one publishes into the void and must never answer `true`. */
    const live = (botId: string): MqttConnection | null => {
        const connection = slots.get(botId)?.connection
        if (!connection) return null
        return connection.isConnected() ? connection : null
    }

    const open = async (slot: Slot) => {
        const botId = slot.runtime.botId
        slot.connecting = true
        const connection = factory({
            url: deps.url,
            username: deps.username,
            password: deps.password,
            clientId: fleetClientId(deps.namespace, botId),
            log: (l, m) => log(l, m, botId),
        })
        try {
            await connection.connect()
            const { grantedQos } = await connection.subscribe(fleetTopic(deps.namespace, botId, 'command'), 1, (topic, payload) => {
                // The topic is untrusted input from the broker, so it is read with the
                // contract's own parser instead of being split by hand — same grammar, same bot id
                // length cap, one place. A wildcard subscription the broker widened, or a retained
                // message on a neighbour's topic, must not be handed to this bot's runtime.
                const addressed = parseCommandTopic(topic)
                if (!addressed || addressed.namespace !== deps.namespace || addressed.botId !== botId) {
                    log('warn', `ignored a message on ${topic}: it is not this bot's command topic`, botId)
                    return
                }
                const parsed = botCommandSchema.safeParse(JSON.parse(payload))
                if (!parsed.success) {
                    log('warn', `command on ${botId} did not validate: ${parsed.error.issues.map((i) => i.message).join('; ')}`, botId)
                    return
                }
                handler?.(addressed.botId, parsed.data).catch((error: unknown) =>
                    log('error', `command handler threw: ${describeThrown(error)}`, botId),
                )
            })
            // QoS 0 is a DOWNGRADE, not a denial: the subscription exists and commands will arrive,
            // just without the delivery guarantee. A denial throws (SubscriptionDeniedError) and is
            // handled in the catch below with its own remedy.
            if (grantedQos !== 1) log('warn', `broker granted QoS ${grantedQos} on the command topic; commands may be lost`, botId)
            slot.connection = connection
            slot.attempt = 0
            deps.bus.emit('link.changed', { botId, connected: true })
            // A bot that has just come back must not wait up to 15 s for the idle heartbeat before
            // remi hears from it again: `touch()` marks the snapshot dirty so the next 250 ms tick
            // publishes. It is a no-op on the very first connection, where the runtime's first tick
            // publishes anyway (`lastPublishedAtMs === null`).
            slot.runtime.touch()
        } catch (error) {
            // A failure past this point must give the connection back: leaving an ended connection in
            // the slot would make `publishState` answer for a pipe that is closed until the next
            // reconcile notices.
            if (slot.connection === connection) slot.connection = null
            await connection.end().catch(() => {})
            const wait = scheduleRetry(slot)
            // CONSTRUCTED, NEVER FORWARDED (see `failure.ts` and `net-failure.ts`).
            // mqtt.js composes its text from the connect options it was handed, so quoting it here
            // would put the broker password into the operator's log.
            const message = describeMqttFailure(error)
            // Three failures that look alike in a log and have nothing else in common.
            if (error instanceof SubscriptionDeniedError) {
                log(
                    'error',
                    `connected, but the broker refused the command subscription (${error.topic}); retrying in ${wait} ms — the credential is fine, its ACL is not: ask Robot.com to allow fleet/${deps.namespace}/bot/+/command for user ${deps.username}`,
                    botId,
                )
            } else if (isProtocolVersionRejection(error)) {
                // The kit speaks MQTT 5 and only MQTT 5, so this one never resolves itself
                // by waiting. It stays at `error` level on every attempt — a silent retry loop is
                // exactly what must not happen — and it never suggests the credential remedy,
                // which would be the wrong afternoon to send the partner on.
                log(
                    'error',
                    `CONNECT refused over the protocol version; this kit speaks MQTT 5 only and does not fall back to 3.1.1, so retrying will not fix it: point MQTT_HOST at an MQTT 5 broker (remi's is EMQX 5) — retrying in ${wait} ms`,
                    botId,
                )
            } else {
                // Read off the CLASSIFICATION, not off mqtt.js's text: every "not authorised" spelling
                // in `describeMqttFailure` keeps that phrase precisely so this stays true.
                const notAuthorised = /not authori/i.test(message)
                log(
                    slot.attempt === 1 ? 'error' : 'warn',
                    `CONNECT failed (${message}); retrying in ${wait} ms${notAuthorised ? ` — check MQTT_USERNAME/MQTT_PASSWORD and that your namespace is ${deps.namespace}; repeated rejections get the client banned for a few minutes` : ''}`,
                    botId,
                )
            }
        } finally {
            slot.connecting = false
        }
    }

    const close = async (slot: Slot, reason: string) => {
        const connection = slot.connection
        slot.connection = null
        // A throw here must not strand the rest of the fleet: `stop()` walks every slot in turn.
        await connection
            ?.end()
            .catch((error: unknown) => log('warn', `closing the connection failed: ${describeThrown(error)}`, slot.runtime.botId))
        deps.bus.emit('link.changed', { botId: slot.runtime.botId, connected: false, reason })
    }

    /** An established connection the broker or the network dropped: backoff, then reconnect. */
    const handleDrop = async (slot: Slot) => {
        const botId = slot.runtime.botId
        const connection = slot.connection
        slot.connection = null
        // `connecting` is the per-slot lock. Without it a reconcile that overlapped this one would see
        // a null connection and a retry time not yet moved, and open a SECOND connection with the same
        // client id — which on a broker means the two kick each other off in turn.
        slot.connecting = true
        try {
            // `end()` also settles any QoS 1 publish still waiting for a PUBACK that is never coming.
            await connection?.end().catch(() => {})
            const wait = scheduleRetry(slot)
            deps.bus.emit('link.changed', { botId, connected: false, reason: 'connection lost' })
            log('warn', `the connection dropped; reconnecting in ${wait} ms`, botId)
        } finally {
            slot.connecting = false
        }
    }

    const reconcile = async () => {
        for (const slot of slots.values()) {
            if (slot.connecting) continue
            if (slot.connection && !slot.connection.isConnected()) await handleDrop(slot)
            const wants = slot.wants()
            if (wants && !slot.connection && deps.now() >= slot.retryAt) await open(slot)
            else if (!wants && slot.connection) await close(slot, 'link policy')
        }
    }

    return {
        kind: 'mqtt',
        async start(bots) {
            for (const runtime of bots) {
                // The link policy reads `snapshot().connected`, which every driver owes the contract,
                // and the runtime forwards. (Detecting a `'wantsConnection' in driver` method instead
                // would need a cast and knowledge of which driver is underneath; this needs neither.)
                slots.set(runtime.botId, {
                    runtime,
                    connection: null,
                    attempt: 0,
                    retryAt: 0,
                    wants: () => runtime.snapshot().connected,
                    connecting: false,
                })
            }
            await reconcile()
            timer = setInterval(() => {
                reconcile().catch((error: unknown) => log('error', `reconcile failed: ${describeThrown(error)}`))
            }, deps.reconcileMs ?? 1_000)
        },
        /**
         * One connection per bot, so a roster change is a slot change. A bot that left gets its
         * connection closed — leaving it open would keep a subscription alive for commands nobody
         * can answer — and a bot whose runtime object was REBUILT (a remap: same id, different
         * robot) is closed too, because the slot's link policy and `touch()` reach through that
         * object and the old one now describes a robot this bot no longer drives. The link policy's
         * own loop does the connecting, exactly as it does at `start`.
         */
        async setBots(bots) {
            const wanted = new Map(bots.map((b) => [b.botId, b]))
            for (const [botId, slot] of [...slots]) {
                const runtime = wanted.get(botId)
                if (runtime && runtime === slot.runtime) continue
                await close(slot, runtime ? 'rebuilt for a new fleet_serial' : 'left the roster')
                slots.delete(botId)
            }
            for (const runtime of bots) {
                if (slots.has(runtime.botId)) continue
                slots.set(runtime.botId, {
                    runtime,
                    connection: null,
                    attempt: 0,
                    retryAt: 0,
                    wants: () => runtime.snapshot().connected,
                    connecting: false,
                })
            }
            await reconcile()
        },
        async stop() {
            if (timer) clearInterval(timer)
            timer = null
            for (const slot of slots.values()) await close(slot, 'stop')
        },
        async publishState(botId, state: BotState) {
            const connection = live(botId)
            // Offline by policy, or dropped: nothing to publish, and the broker is what tells remi.
            // Returning false (not silently "done") is what keeps `state.published` honest.
            if (!connection) return false
            await connection.publish(fleetTopic(deps.namespace, botId, 'state'), state, { qos: 1, retain: true })
            return true
        },
        async publishEvent(botId, event: BotEvent) {
            const connection = live(botId)
            if (!connection) return false
            await connection.publish(fleetTopic(deps.namespace, botId, 'event'), event, { qos: 1, retain: false })
            return true
        },
        /** MQTT publishes as it goes; there is no batch to close. */
        async flushTick() {},
        onCommand(fn) {
            handler = fn
        },
        setLinkPolicy(botId, wants) {
            const slot = slots.get(botId)
            if (slot) slot.wants = wants
        },
        reconcile,
    }
}
