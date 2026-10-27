/**
 * The real probes behind `efk check` C5, C6 and C8.
 *
 * NO PROBE EVER FORWARDS THE EXCEPTION IT CAUGHT. C5 and C6 echo `probe.error` VERBATIM into their verdict, and that verdict is the first
 * thing a partner pastes into a support email. A raw throw from mqtt.js or from `fetch` is not a
 * diagnostic the kit controls: it can carry the broker password (mqtt.js builds its message from the
 * connect options on some paths), the bearer token, or the full request URL including any userinfo a
 * partner put in `HTTP_PUBLIC_URL`. So every string returned in `error` below is CONSTRUCTED here
 * from a classification, never quoted from the throw.
 *
 * Classifying ON the message is fine and is what `isProtocolVersionRejection` already does; the rule
 * is about what leaves, not about what we may read. The only values quoted are Node's and MQTT's own
 * constants — `ECONNREFUSED`, a CONNACK reason code — which are enumerations, not secrets.
 *
 * The other thing C5 depends on is the word "not authorised": `check.ts` branches on
 * `/not authori/i` to choose between the credential remedy and the network remedy. Every
 * authentication classification below keeps that phrase, or the partner gets sent to debug their
 * firewall over a wrong password.
 */
import mqtt from 'mqtt'
import { runParityInProcess } from '../contract/parity-runner'
import { describeFetchFailure } from '../net-failure'
import { describeMqttFailure } from '../transport/mqtt/failure'

const PROBE_TIMEOUT_MS = 5_000

export type MqttProbeResult = { connack: boolean; grantedQos: number; error?: string }

/**
 * C5: CONNECT with a DIAGNOSTIC client id (the caller builds it, `fleetCheckClientId`) and SUBSCRIBE
 * to the command filter, then leave. It never publishes and never evicts a live bot.
 *
 * TWO STAGES, REPORTED APART. The brief's version wrapped CONNECT and SUBSCRIBE in one `try` and
 * answered `connack: false` for both, so a broker that accepted the credential and then refused the
 * ACL on the command topic came back as "broker refused CONNECT (not authorised)" — which sends the
 * partner to re-check a password that is perfectly correct, when the fix is an ACL on our side. A
 * denied subscription keeps `connack: true` and reports the refusal through `grantedQos`, which is
 * the field C5 already reads for exactly this class of problem and whose remedy already says "ask
 * Robot.com to check the ACL on your credential".
 *
 * The client is ended in `finally`, not on the success path. With `reconnectPeriod: 0` a connection
 * left open after a failed SUBSCRIBE is an open handle, and `efk check` would simply never exit.
 */
export async function mqttProbe(opts: {
    url: string
    username: string
    password: string
    clientId: string
    commandTopicFilter: string
}): Promise<MqttProbeResult> {
    let client: mqtt.MqttClient | null = null
    try {
        client = await mqtt.connectAsync(opts.url, {
            clientId: opts.clientId,
            username: opts.username,
            password: opts.password,
            protocolVersion: 5,
            clean: true,
            connectTimeout: PROBE_TIMEOUT_MS,
            reconnectPeriod: 0,
        })
    } catch (error) {
        return { connack: false, grantedQos: -1, error: describeMqttFailure(error) }
    }
    try {
        const granted = await client.subscribeAsync(opts.commandTopicFilter, { qos: 1 })
        // 128 (0x80) is the SUBACK failure code; mqtt.js also reports a denial as a rejected promise.
        const grantedQos = granted[0]?.qos ?? -1
        return grantedQos === 128
            ? { connack: true, grantedQos: -1, error: 'the broker refused the command subscription' }
            : { connack: true, grantedQos }
    } catch (error) {
        return { connack: true, grantedQos: -1, error: `the broker refused the command subscription: ${describeMqttFailure(error)}` }
    } finally {
        await client.endAsync().catch(() => {})
    }
}

export type HttpProbeResult = { status: number; body?: unknown; error?: string }

/** C6: does this machine reach the partner's own `GET /bots`? Never proof that remi can. */
export async function httpProbe(url: string, token: string): Promise<HttpProbeResult> {
    try {
        const response = await fetch(url, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        const body = response.ok ? await response.json().catch(() => undefined) : undefined
        return { status: response.status, body }
    } catch (error) {
        return { status: 0, error: describeFetchFailure(error, PROBE_TIMEOUT_MS) }
    }
}

/**
 * C8 runs the SAME function `parity.test.ts` runs, in process. If the two could diverge,
 * the command a partner is asked to run first and the suite we run in CI could disagree about
 * whether their copy of `src/contract/` is intact.
 */
export const parityProbe = (): Promise<{ ok: boolean; detail: string }> => runParityInProcess()
