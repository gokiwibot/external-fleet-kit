/**
 * A thin wrapper over mqtt.js for ONE bot connection. `mqtts`, MQTT 5, keepalive 30, clean session,
 * no Last Will (the page: liveness is a property of the connection). Handlers never throw into
 * mqtt.js: a bad payload costs a log line, not the bot.
 *
 * MQTT 5, FIXED, NO FALLBACK. mqtt.js only downgrades to 3.1.1 on its own when `reconnectPeriod` is
 * non-zero — it needs a reconnection to try the other version — and this client sets
 * `reconnectPeriod: 0` because the transport owns the retries and the backoff (the page forbids
 * retrying a rejected CONNECT in a tight loop, and mqtt.js's own reconnection has no backoff). So
 * writing "falls back if the broker asks" here would be false. It does not need to be true: the
 * broker is EMQX and the contract page documents MQTT 5 features the fleet relies on. What the
 * fixed version DOES owe the partner is a legible failure when a broker refuses it, which is what
 * `isProtocolVersionRejection` below is for (ruling R2).
 */
import mqtt, { type MqttClient } from 'mqtt'

/** Thrown when CONNECT succeeded but the broker refused the subscription (SUBACK failure). */
export class SubscriptionDeniedError extends Error {
    constructor(
        readonly topic: string,
        options?: { cause?: unknown },
    ) {
        super(`broker denied the subscription to ${topic}`, options)
        this.name = 'SubscriptionDeniedError'
    }
}

/** CONNACK reason codes for "I do not speak your protocol version": 0x01 in 3.1.1, 0x84 in MQTT 5. */
const PROTOCOL_VERSION_REASON_CODES: ReadonlySet<number> = new Set([1, 132])

/**
 * Ruling R2 buys "MQTT 5 only, no 3.1.1 fallback" at the price of a legible failure: a CONNACK
 * refused over the protocol version must say so, instead of disappearing into the same retry loop
 * as a wrong password — whose remedy ("check MQTT_USERNAME/MQTT_PASSWORD") would send the partner
 * looking in the wrong place for ever. mqtt.js reports it as an `ErrorWithReasonCode` carrying the
 * numeric CONNACK reason code; the message check is the fallback for anything in between (a proxy,
 * a future mqtt.js) that only gives us the text.
 */
export function isProtocolVersionRejection(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const code: unknown = (error as { code?: unknown }).code
    if (typeof code === 'number' && PROTOCOL_VERSION_REASON_CODES.has(code)) return true
    return /protocol version/i.test(error.message)
}

export type MqttConnectionOptions = {
    url: string
    username: string
    password: string
    clientId: string
    keepalive?: number
    log: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface MqttConnection {
    connect(): Promise<void>
    publish(topic: string, payload: unknown, options: { qos: 0 | 1 | 2; retain: boolean }): Promise<void>
    subscribe(topic: string, qos: 0 | 1 | 2, handler: (topic: string, payload: string) => void): Promise<{ grantedQos: number }>
    end(): Promise<void>
    isConnected(): boolean
}

export function createMqttConnection(options: MqttConnectionOptions): MqttConnection {
    let client: MqttClient | null = null
    const handlers: Array<{ topic: string; handler: (topic: string, payload: string) => void }> = []
    return {
        async connect() {
            const connected = await mqtt.connectAsync(options.url, {
                clientId: options.clientId,
                username: options.username,
                password: options.password,
                protocolVersion: 5,
                keepalive: options.keepalive ?? 30,
                clean: true,
                reconnectPeriod: 0, // the transport owns retries and backoff
            })
            // mqtt.js removes its own `error` listener as soon as the connect promise settles, and an
            // EventEmitter that emits `error` with no listener THROWS — a socket reset after a healthy
            // CONNECT would take the whole kit down with it. The transport learns about the drop from
            // `isConnected()` (ruling R3); this listener exists so the process survives long enough to
            // be told. It never prints the credential: only the error's own message.
            connected.on('error', (error: Error) => options.log('warn', `mqtt client error: ${error.message}`))
            connected.on('message', (topic, payload) => {
                for (const { topic: wanted, handler } of handlers) {
                    if (wanted !== topic) continue
                    try {
                        handler(topic, payload.toString())
                    } catch (error) {
                        options.log('error', `handler for ${topic} threw: ${String(error)}`)
                    }
                }
            })
            client = connected
        },
        async publish(topic, payload, { qos, retain }) {
            // `client.connected` and not just `client`: with `reconnectPeriod: 0` a QoS 1 publish on a
            // dropped client waits for a PUBACK that will never come, and would hang the tick that is
            // awaiting it until something calls `end()`.
            if (!client?.connected) throw new Error('not connected')
            await client.publishAsync(topic, JSON.stringify(payload), { qos, retain })
        },
        async subscribe(topic, qos, handler) {
            if (!client) throw new Error('not connected')
            handlers.push({ topic, handler })
            // A DENIED subscription comes back two different ways depending on the mqtt.js path: a
            // rejected promise, or a resolved one whose granted QoS is 128 (0x80 = failure). Both are
            // "the broker said no to this topic", which is a completely different problem from a
            // refused CONNECT — the credential is fine, the ACL is not — and the caller has to be
            // able to tell them apart to print the right remedy.
            let granted: Array<{ topic: string; qos: number }>
            try {
                granted = await client.subscribeAsync(topic, { qos })
            } catch (error) {
                throw new SubscriptionDeniedError(topic, { cause: error })
            }
            const grantedQos = granted[0]?.qos ?? -1
            if (grantedQos === 128 || grantedQos < 0) throw new SubscriptionDeniedError(topic)
            return { grantedQos }
        },
        async end() {
            if (!client) return
            const current = client
            client = null
            await current.endAsync()
        },
        isConnected: () => client?.connected ?? false,
    }
}
