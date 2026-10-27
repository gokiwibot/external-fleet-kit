/**
 * An mqtt.js failure in the kit's own words. Same rule as `net-failure.ts`, which this builds on:
 * **the string is constructed, never forwarded**. mqtt.js composes its messages from the connect
 * options it was handed, so its text is not ours to quote — and `efk check` C5 echoes whatever it is
 * given straight into a report a partner pastes to us.
 *
 * The one phrase that must survive every classification is "not authorised". `check.ts` C5 branches
 * on `/not authori/i` to choose between the credential remedy and the network remedy; a
 * classification that loses it sends a partner with a wrong password off to debug their firewall.
 */
import { describeSocketCode, errorCode } from '../../net-failure'

/** CONNACK reason codes for "I do not speak your protocol version": 0x01 in 3.1.1, 0x84 in MQTT 5. */
const PROTOCOL_VERSION_REASON_CODES: ReadonlySet<number> = new Set([1, 132])

/**
 * "MQTT 5 only, no 3.1.1 fallback" comes at the price of a legible failure: a CONNACK
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

const readsAsNotAuthorised = (error: unknown): boolean =>
    error instanceof Error && /not authori[sz]ed|bad user ?name|bad credentials/i.test(error.message)

/**
 * The order matters: a protocol-version rejection has a remedy that is NOT "check your password",
 * so it is classified before the generic tables.
 */
export function describeMqttFailure(error: unknown): string {
    if (isProtocolVersionRejection(error)) {
        return 'the broker refused the MQTT 5 protocol version; this kit does not fall back to 3.1.1'
    }
    const code = errorCode(error)
    if (typeof code === 'number') {
        return CONNACK_REASONS[code] ?? `the broker refused CONNECT with reason code 0x${code.toString(16).padStart(2, '0')}`
    }
    const described = describeSocketCode(code)
    if (described) return described
    // No code at all: mqtt.js reports some 3.1.1 refusals as a bare Error, so the message is read —
    // and only read — to keep C5's credential branch working.
    if (readsAsNotAuthorised(error)) return 'not authorised: the broker refused this credential'
    if (error instanceof Error && /timed? ?out/i.test(error.message)) return 'the connection timed out'
    return 'the connection failed with no code this kit can safely quote'
}
