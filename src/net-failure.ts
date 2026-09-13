/**
 * How the kit describes a network failure to a human, and the rule behind every line of it:
 *
 * **THE ERROR STRING IS CONSTRUCTED, NEVER FORWARDED** (controller ruling). `fetch` and mqtt.js build
 * their own messages out of the request they were given, and that includes credentials. This is not a
 * precaution — it is measured, on this machine, with the stock node that runs the kit:
 *
 *     fetch('https://user:supersecret@fleet.acme.com/v1/bots')
 *     → TypeError: Request cannot be constructed from a URL that includes credentials:
 *                  https://user:supersecret@fleet.acme.com/v1/bots
 *
 * Anything that echoed `error.message` — `efk check` C5 and C6, the remi client's `NETWORK` result
 * that C2 prints, the MQTT transport's `CONNECT failed (…)` — would put that password on a partner's
 * screen and into the support email they paste it into. This repo is public.
 *
 * So the failure is CLASSIFIED and then described in the kit's own words. It is deliberately not a
 * sanitiser: a filter that strips known secrets out of a library's text is a list someone will
 * eventually outgrow, and the first thing it misses is the thing it was written for. Nothing from the
 * exception's message ever reaches the output. The only values quoted are node's own error codes —
 * `ECONNREFUSED`, `ENOTFOUND` — which are a closed enumeration, not data.
 *
 * Reading the message to classify it is fine; that is what `isProtocolVersionRejection` already does.
 * The rule is about what leaves, not about what we may look at.
 */

/** Node system and TLS error codes worth naming. Shared with the MQTT classifier next to the transport. */
export const SOCKET_REASONS: Readonly<Record<string, string>> = {
    ECONNREFUSED: 'the host refused the connection (ECONNREFUSED)',
    ENOTFOUND: 'the host name did not resolve (ENOTFOUND)',
    EAI_AGAIN: 'the host name did not resolve, DNS is not answering (EAI_AGAIN)',
    ETIMEDOUT: 'the connection timed out (ETIMEDOUT)',
    ECONNRESET: 'the connection was reset (ECONNRESET)',
    EHOSTUNREACH: 'the host is unreachable from this machine (EHOSTUNREACH)',
    ENETUNREACH: 'the network is unreachable from this machine (ENETUNREACH)',
    EPROTO: 'the TLS handshake failed (EPROTO) — is the port really TLS?',
    CERT_HAS_EXPIRED: 'the TLS certificate has expired (CERT_HAS_EXPIRED)',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'the TLS certificate is self-signed (DEPTH_ZERO_SELF_SIGNED_CERT)',
    SELF_SIGNED_CERT_IN_CHAIN: 'the TLS chain ends in a self-signed certificate (SELF_SIGNED_CERT_IN_CHAIN)',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the TLS certificate could not be verified (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
}

export const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null | undefined)?.code
const errorCause = (error: unknown): unknown => (error as { cause?: unknown } | null | undefined)?.cause

/** A node error code is a constant from a closed set, so naming it is safe. Anything else is not. */
export function describeSocketCode(code: unknown): string | null {
    if (typeof code !== 'string') return null
    const known = SOCKET_REASONS[code]
    if (known) return known
    return /^[A-Z][A-Z0-9_]*$/.test(code) ? `the connection failed (${code})` : null
}

/**
 * A URL reduced to what is safe to print: scheme, host and port. `URL.origin` drops any
 * `user:password@` — which is the whole point, since that is exactly what a partner may have put in
 * `REMI_API_URL` or `HTTP_PUBLIC_URL`. A string that is not a URL is not echoed back either.
 */
export function safeOrigin(url: string): string {
    try {
        const parsed = new URL(url)
        // An OPAQUE origin comes back as the literal string "null", and that is not a corner case
        // here: `user:secret@host` parses happily as a URL whose SCHEME is `user:`. Printing "null"
        // would be nonsense, and reaching for `href` instead would print the very credentials this
        // function exists to keep out.
        return parsed.origin === 'null' ? 'the configured URL' : parsed.origin
    } catch {
        return 'the configured URL'
    }
}

/**
 * `fetch`'s failure, in the kit's words. The system error hides one level down, in `cause`.
 * `timeoutMs` is named only when the caller set one, so the line cannot claim a deadline that
 * does not exist.
 */
export function describeFetchFailure(error: unknown, timeoutMs?: number): string {
    const name = (error as { name?: unknown } | null | undefined)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
        return timeoutMs === undefined ? 'the request timed out' : `no answer within ${timeoutMs / 1_000} s`
    }
    for (const candidate of [errorCode(error), errorCode(errorCause(error))]) {
        const described = describeSocketCode(candidate)
        if (described) return described
    }
    if (error instanceof Error) {
        /**
         * THE MEASURED LEAK. Given a URL of the form `https://user:password@host/path`, node's
         * `fetch` refuses it and quotes the WHOLE URL, password included, in the message. Described,
         * never quoted — and it names the fix, which the raw text does not.
         */
        if (/includes credentials/i.test(error.message)) {
            return 'the URL carries a user:password, which fetch refuses to send; take the credentials out of it (the kit authenticates with a token, not with userinfo)'
        }
        // `TypeError: Failed to parse URL from …` quotes the URL too.
        if (/parse url|invalid url/i.test(error.message)) return 'that is not a URL fetch can use'
    }
    return 'the request failed with no code this kit can safely quote'
}
