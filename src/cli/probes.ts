/**
 * The real probes behind `efk check` C5, C6 and C8.
 *
 * NO PROBE EVER FORWARDS THE EXCEPTION IT CAUGHT (controller ruling, cross-task obligation for this
 * task). C5 and C6 echo `probe.error` VERBATIM into their verdict, and that verdict is the first
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
import { isProtocolVersionRejection } from '../transport/mqtt/connection'

const PROBE_TIMEOUT_MS = 5_000

/** Node system and TLS error codes worth naming. The code itself is a constant, never a credential. */
const SOCKET_REASONS: Readonly<Record<string, string>> = {
    ECONNREFUSED: 'the host refused the connection (ECONNREFUSED)',
    ENOTFOUND: 'the host name did not resolve (ENOTFOUND)',
    EAI_AGAIN: 'the host name did not resolve, DNS is not answering (EAI_AGAIN)',
    ETIMEDOUT: `no answer within ${PROBE_TIMEOUT_MS / 1_000} s (ETIMEDOUT)`,
    ECONNRESET: 'the connection was reset (ECONNRESET)',
    EHOSTUNREACH: 'the host is unreachable from this machine (EHOSTUNREACH)',
    ENETUNREACH: 'the network is unreachable from this machine (ENETUNREACH)',
    EPROTO: 'the TLS handshake failed (EPROTO) — is the port really TLS?',
    CERT_HAS_EXPIRED: 'the TLS certificate has expired (CERT_HAS_EXPIRED)',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'the TLS certificate is self-signed (DEPTH_ZERO_SELF_SIGNED_CERT)',
    SELF_SIGNED_CERT_IN_CHAIN: 'the TLS chain ends in a self-signed certificate (SELF_SIGNED_CERT_IN_CHAIN)',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the TLS certificate could not be verified (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
}

/** CONNACK reason codes, MQTT 5 first and the 3.1.1 equivalents beside them. */
const CONNACK_REASONS: Readonly<Record<number, string>> = {
    2: 'the broker rejected the client id (CONNACK 0x02)',
    3: 'the broker is unavailable (CONNACK 0x03)',
    4: 'not authorised: the broker rejected the user name or password (CONNACK 0x04)',
    5: 'not authorised: the broker refused this credential (CONNACK 0x05)',
    128: 'the broker refused CONNECT without saying why (CONNACK 0x80)',
    133: 'the broker rejected the client id (CONNACK 0x85)',
    134: 'not authorised: the broker rejected the user name or password (CONNACK 0x86)',
    135: 'not authorised: the broker refused this credential (CONNACK 0x87)',
    136: 'the broker is unavailable (CONNACK 0x88)',
    137: 'the broker is busy (CONNACK 0x89)',
    138: 'not authorised: this client is banned, which is what repeated bad logins earn (CONNACK 0x8A)',
    151: 'the broker says the quota is exhausted (CONNACK 0x97)',
    159: 'the connection rate was exceeded (CONNACK 0x9F)',
}

const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null | undefined)?.code
const errorCause = (error: unknown): unknown => (error as { cause?: unknown } | null | undefined)?.cause
const readsAsNotAuthorised = (error: unknown): boolean =>
    error instanceof Error && /not authori[sz]ed|bad user ?name|bad credentials/i.test(error.message)

/**
 * The sanitised description of a failed CONNECT. Reads the throw; quotes none of it.
 * The order matters: the protocol-version rejection shares reason code space with nothing else and
 * has a remedy that is not "check your password", so it is classified before the generic table.
 *
 * Exported for `probes.test.ts`, which feeds it a throw whose message carries a password: that is
 * the only way to falsify "the probe builds its own string" rather than merely observing that a
 * particular network failure happened not to contain one.
 */
export function describeConnectFailure(error: unknown): string {
    if (isProtocolVersionRejection(error)) {
        return 'the broker refused the MQTT 5 protocol version; this kit does not fall back to 3.1.1'
    }
    const code = errorCode(error)
    if (typeof code === 'number') {
        return CONNACK_REASONS[code] ?? `the broker refused CONNECT with reason code 0x${code.toString(16).padStart(2, '0')}`
    }
    if (typeof code === 'string') {
        const known = SOCKET_REASONS[code]
        if (known) return known
        // An unmapped Node code. The code is a constant from Node's own enumeration, so naming it is
        // safe; the message it came with is not, and does not travel.
        if (/^[A-Z][A-Z0-9_]*$/.test(code)) return `the connection failed (${code})`
    }
    // No code at all. mqtt.js reports some 3.1.1 refusals as a bare Error, so the message is read —
    // and only read — to keep C5's credential branch working.
    if (readsAsNotAuthorised(error)) return 'not authorised: the broker refused this credential'
    if (error instanceof Error && /timed? ?out/i.test(error.message)) return `no answer within ${PROBE_TIMEOUT_MS / 1_000} s`
    return 'the connection failed before CONNACK, with no code this kit can safely quote'
}

/** Same rules for `fetch`, whose system error hides one level down in `cause`. Exported to be falsified. */
export function describeFetchFailure(error: unknown): string {
    const name = (error as { name?: unknown } | null | undefined)?.name
    if (name === 'TimeoutError' || name === 'AbortError') return `no answer within ${PROBE_TIMEOUT_MS / 1_000} s`
    for (const candidate of [errorCode(error), errorCode(errorCause(error))]) {
        if (typeof candidate !== 'string') continue
        const known = SOCKET_REASONS[candidate]
        if (known) return known
        if (/^[A-Z][A-Z0-9_]*$/.test(candidate)) return `the request failed (${candidate})`
    }
    if (error instanceof Error) {
        /**
         * THE LEAK THIS WHOLE MODULE EXISTS FOR, and it is not hypothetical. Given an
         * `HTTP_PUBLIC_URL` of the form `https://user:password@host/path`, node's `fetch` throws
         *   TypeError: Request cannot be constructed from a URL that includes credentials: <the whole URL>
         * — password and all. The brief's probe returned `error.message` verbatim, C6 echoes the
         * probe's error verbatim, and `efk check` is the first command we ask a partner to run and
         * paste to us. Described, never quoted.
         */
        if (/includes credentials/i.test(error.message)) {
            return 'HTTP_PUBLIC_URL carries a user:password in the URL, which fetch refuses to send; take the credentials out of the URL (HTTP_TOKEN is how the kit authenticates)'
        }
        // `TypeError: Failed to parse URL from …` would quote the URL too.
        if (/parse url|invalid url/i.test(error.message)) return 'HTTP_PUBLIC_URL is not a URL fetch can use'
    }
    return 'the request failed with no code this kit can safely quote'
}

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
        return { connack: false, grantedQos: -1, error: describeConnectFailure(error) }
    }
    try {
        const granted = await client.subscribeAsync(opts.commandTopicFilter, { qos: 1 })
        // 128 (0x80) is the SUBACK failure code; mqtt.js also reports a denial as a rejected promise.
        const grantedQos = granted[0]?.qos ?? -1
        return grantedQos === 128
            ? { connack: true, grantedQos: -1, error: 'the broker refused the command subscription' }
            : { connack: true, grantedQos }
    } catch (error) {
        return { connack: true, grantedQos: -1, error: `the broker refused the command subscription: ${describeConnectFailure(error)}` }
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
        return { status: 0, error: describeFetchFailure(error) }
    }
}

/**
 * C8 runs the SAME function `parity.test.ts` runs (Task 2), in process. If the two could diverge,
 * the command a partner is asked to run first and the suite we run in CI could disagree about
 * whether their copy of `src/contract/` is intact.
 */
export const parityProbe = (): Promise<{ ok: boolean; detail: string }> => runParityInProcess()
