/**
 * How the kit describes a network failure to a human, and the rule behind every line of it:
 *
 * **THE ERROR STRING IS CONSTRUCTED, NEVER FORWARDED**. `fetch` and mqtt.js build
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
    EADDRINUSE: 'something is already listening on that address (EADDRINUSE)',
    EACCES: 'this process is not allowed to use that address or port (EACCES)',
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

/**
 * The last resort, for a throw out of a library we do not control that is reported to a user but is
 * not a `fetch` or a CONNECT — a publish that was rejected, a connection that would not close, a
 * handler that blew up. Same rule, same reason: the code, never the text.
 *
 * The error's CLASS is named when there is no code, and that is deliberate. A class name is an
 * identifier from somebody's source, not data from a connection, and it carries the one distinction
 * the reader needs: `TypeError` says "this is a bug in the kit", where `Error` with an `ECONNRESET`
 * says "the network went away". Losing that would make the constructed message strictly less useful
 * than the raw one, which is not a trade worth making.
 *
 * NOT FOR EVERY `catch`. Where the exception IS the diagnostic and comes from something the reader
 * owns — a syntax error in their own `efk.config.ts`, a throw out of their own driver, a JSON parse
 * failure on a file they can open — the message is the whole point and is kept. The rule is about
 * libraries that build their text out of connection options: those are `fetch` and mqtt.js.
 */
export function describeThrown(error: unknown): string {
    const socket = describeSocketCode(errorCode(error))
    if (socket) return socket
    const code = errorCode(error)
    if (typeof code === 'number') return `it was refused with reason code 0x${code.toString(16).padStart(2, '0')}`
    const kind = error instanceof Error ? error.name : typeof error
    return `${kind}, with no code this kit can safely quote`
}

/**
 * The stack frames of an error, with its message removed EXACTLY rather than heuristically.
 *
 * A bug report needs the frames — file paths and function names out of this repo — but `Error.stack`
 * BEGINS with the message, which is the one thing the rule above keeps out. The first version of
 * this filtered for lines matching `/^\s+at /`, and a reviewer defeated it in one line: an error
 * whose MESSAGE contains `"\n    at fake-frame (password=…)"` has a message line that matches the
 * frame pattern, so the pattern kept it and the credential printed as though it were a frame.
 *
 * That is the same defect this plan has now hit three times — a guard that matches a pattern admits
 * whatever coincidentally matches the pattern — and it has the same answer as the `efk check`
 * remedies did: make the exclusion STRUCTURAL instead of heuristic. `stack` starts with a header of
 * the form `<name>: <message>`, so the message can be removed by its own length. A multi-line
 * message is then excluded in full, by construction, and no pattern is consulted.
 *
 * When the message cannot be located in the header — a runtime that formats `stack` differently, a
 * custom error that overwrote it — this returns NOTHING rather than guessing which part is safe.
 * Losing the frames is a worse bug report; leaking a credential is a worse day.
 */
export function stackFramesWithoutMessage(error: unknown): string {
    if (!(error instanceof Error) || typeof error.stack !== 'string') return ''
    const { stack, message } = error
    const start = stack.indexOf(message)
    // It must be the HEADER's copy of the message: anything before it is `<name>: `, which has no
    // newline in it. A message found only further down is a coincidence in a frame, not the header.
    if (start === -1 || stack.slice(0, start).includes('\n')) return ''
    const afterMessage = stack.slice(start + message.length)
    const firstBreak = afterMessage.indexOf('\n')
    return firstBreak === -1 ? '' : afterMessage.slice(firstBreak + 1)
}
