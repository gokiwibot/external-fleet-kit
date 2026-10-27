/**
 * pino with two guarantees: secrets never reach a sink — by key (a key is
 * never printed with its value, at any depth) and by value (a scrubber over serialized text, because
 * a token inside a free-text message has no key) — and every line is mirrored onto the bus so the
 * TUI's LOG section and the web dashboard see it. With the TUI mounted the sink is the bus alone:
 * anything written to stdout would tear the screen.
 *
 * BOTH GUARANTEES ARE ENFORCED AT `bus.emit`, NOT ONLY AT PINO'S OUTPUT. Almost nothing in this kit
 * logs through the `Logger` object: the core reports with `bus.emit('log', …)`, and
 * `bot-runtime.ts` hands a PARTNER'S OWN DRIVER a `log(message, data)` seam that emits straight onto
 * the bus with a `data` object this repo never sees. That payload goes to the TUI and, through
 * `onAny`, to every `/events` subscriber, without passing through pino at all — so redaction that
 * lived only in pino's serializer protected the one route whose author we control and left the one
 * we do not wide open. `createLogger` therefore wraps `bus.emit` once, and everything downstream —
 * the TUI, the SSE stream, `/api/snapshot`, `replay()` and the stderr sink — sees redacted payloads.
 *
 * THAT MAKES THIS AN OUTBOUND DATA PATH, NOT ONLY A LOGGING ONE, and the trade-offs below are set
 * accordingly. `fleet-manager.ts` subscribes to `event.emitted` and republishes `e.event` TO REMI
 * through the transport, and that event is emitted before it is published — so what remi receives is
 * the redacted copy, `detail` included, and `detail` comes straight from the partner's driver. A
 * false positive here (a password that happens to be a dictionary word, matched inside innocent
 * text) does not merely garble a log line, it garbles what remi is told. So: nothing is ever dropped
 * where it can be preserved (see the DAG memo in `redactValue`), the round trip is pinned by tests
 * against the frozen contract samples for both `state.published` and `event.emitted`, and the README
 * has to say plainly that the redactor sits on this path.
 */
import pino, { type Logger } from 'pino'
import type { EventBus, EventName, KitEvents } from './core/events'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LoggerOptions = {
    sink: 'stderr' | 'bus'
    secrets: string[]
    /** Injected in tests; defaults to process.stderr.write. */
    write?: (line: string) => void
}

const LEVEL_VALUE: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 }

const REDACTED = '[redacted]'

/**
 * Keys whose VALUE is never printed, whatever it is and however deep it sits.
 *
 * The first four are the kit's own `.env` names; the last four are the generic shape a future call
 * site will reach for, because every option object in this repo that carries a credential calls it
 * exactly one of these — `password` (`transport/mqtt/connection.ts`, `cli/probes.ts`, `cli/check.ts`),
 * `token` (`transport/http/index.ts`, `transport/http/server.ts`), `apiKey` (`remi/client.ts`).
 * Value-level scrubbing only knows the three secrets `start.ts` hands it; these are what catch a
 * credential that never went through `.env` at all.
 */
const REDACT_KEYS = ['authorization', 'REMI_API_KEY', 'MQTT_PASSWORD', 'HTTP_TOKEN', 'password', 'token', 'apiKey', 'secret']

/**
 * Key matching ignores case and the separators people disagree about, so `MQTT_PASSWORD`,
 * `mqttPassword`, `api_key` and `apiKey` are all the same key. Over-matching here is the safe
 * direction: a field innocently named `token` costs one censored value in a log line, while a missed
 * one costs a credential.
 */
const normalizeKey = (key: string): string => key.toLowerCase().replaceAll('_', '').replaceAll('-', '')
const SECRET_KEYS = new Set(REDACT_KEYS.map(normalizeKey))

/**
 * pino's own redaction, which runs on the merging object BEFORE it is serialized — so a large secret
 * never reaches the serializer at all. fast-redact's `*` matches exactly ONE level, so each key is
 * listed at depths 0, 1 and 2; `redactValue` below is what makes the guarantee depth-independent,
 * and it runs over everything this module puts on the bus, pino's own lines included. The four
 * explicit `headers.`/`env.` paths are the spellings the task brief named and are kept verbatim,
 * even though the wildcards already subsume them.
 */
const REDACT_PATHS = [
    ...REDACT_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
    'headers.authorization',
    'env.REMI_API_KEY',
    'env.MQTT_PASSWORD',
    'env.HTTP_TOKEN',
]

/**
 * How deep `redactValue` walks. Past it the whole subtree becomes `[redacted]` rather than being
 * passed through: the bound is FAIL-CLOSED on purpose, so it is not the silent depth limit that a
 * wildcard path list is. Twelve levels is far past anything a log payload has any business being.
 *
 * IT IS NOT THE CYCLE GUARD, and an earlier version that leaned on it for that was a way to kill the
 * process. A depth bound caps depth, not node COUNT: an object whose k keys point back at itself
 * expands to k¹² nodes before the bound stops anything. Measured against that version on this
 * machine, a uniform 5-key cycle exhausted a 256 MB heap and took the process with it.
 *
 * The route in is `bot-runtime.ts`'s `log(message, data)` seam, which hands a PARTNER'S driver a
 * direct line onto the bus. The obvious candidate — the error that driver's own HTTP client threw,
 * carrying axios/undici `config`/`request`/`response` back-links — turns out NOT to be the dangerous
 * one: roughly one back-edge per node keeps it near-linear, and it finished in ~3 ms even unguarded.
 * The shape that kills is one where SEVERAL of an object's own keys alias the object itself — a
 * shared context, registry or client exposed as `self`, `parent`, `root` and `instance` at once,
 * which is ordinary in a driver and produces k back-edges from one node. A realistic-looking case
 * surviving is not evidence the guard is unnecessary.
 * `seen`/`active` below is the real guard; this bound is the second net.
 */
export const MAX_REDACT_DEPTH = 12

/** What a reference that points back into its own ancestry is replaced with. */
const CIRCULAR = '[circular]'

/**
 * One redaction pass over a whole bus payload: secret KEYS censored at any depth, every string value
 * scrubbed for secret VALUES. Returns a copy; the caller's object is never mutated, because the
 * payload it was handed belongs to whoever emitted it and may still be in use.
 *
 * Two structures, because a cycle and a shared reference are not the same thing and must not be
 * treated the same way:
 *
 *  - `active` is the objects on the path from the root to here. Meeting one again IS a cycle, and it
 *    becomes `[circular]` — which also keeps the copy acyclic, so `JSON.stringify` downstream (the
 *    SSE stream does exactly that on every event) cannot throw on it.
 *  - `seen` memoises objects already finished. Meeting one again is a shared reference in a DAG, and
 *    it yields THE SAME redacted copy: no data is lost, and no subtree is walked twice, which is
 *    what bounds the total work to the node count rather than to `k ** depth`.
 *
 * Collapsing a shared reference to a marker would have been simpler, and wrong: the redactor sits on
 * an OUTBOUND data path (see `createLogger`), so anything it drops is dropped on its way to remi.
 */
function redactValue(
    value: unknown,
    scrub: (text: string) => string,
    depth: number,
    seen: WeakMap<object, unknown>,
    active: WeakSet<object>,
): unknown {
    if (typeof value === 'string') return scrub(value)
    if (value === null || typeof value !== 'object') return value
    if (active.has(value)) return CIRCULAR
    // BEFORE the memo lookup, not after. `seen` keys on object identity alone, with no depth in it,
    // so an object first met shallow is expanded and cached — and returning that cache to a later,
    // DEEPER visit served the full expansion from past the bound, defeating the fail-closed net for
    // exactly the case it exists for. Depth wins over the memo; a shared object is therefore intact
    // wherever it is reachable inside the bound and censored wherever it is not.
    if (depth > MAX_REDACT_DEPTH) return REDACTED
    const memo = seen.get(value)
    if (memo !== undefined) return memo
    // A Date survives as itself: walking its (empty) enumerable entries would turn a timestamp a
    // partner's driver logged into `{}`, which is data loss dressed up as redaction.
    if (value instanceof Date) return value
    active.add(value)
    // Plain loops, not `map`/`Object.fromEntries`: this runs on every event on the bus, up to 800 a
    // second on a 200-bot roster, and the pair array those build is pure garbage.
    let out: unknown
    if (Array.isArray(value)) {
        const items: unknown[] = []
        for (const item of value) items.push(redactValue(item, scrub, depth + 1, seen, active))
        out = items
    } else {
        const record: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value)) {
            record[key] = SECRET_KEYS.has(normalizeKey(key)) ? REDACTED : redactValue(item, scrub, depth + 1, seen, active)
        }
        out = record
    }
    active.delete(value)
    seen.set(value, out)
    return out
}

/** The entry point: one pair of guards per payload, never shared between events. */
function redactPayload(value: unknown, scrub: (text: string) => string): unknown {
    return redactValue(value, scrub, 0, new WeakMap(), new WeakSet())
}

/** Needles shorter than this are dropped; a base64 window shorter than that is dropped too. */
const MIN_NEEDLE_LENGTH = 4
const MIN_BASE64_WINDOW = 8

/**
 * The secret's own base64, at each of the three byte alignments it can sit at inside a bigger blob.
 *
 * `Authorization: Basic <base64("user:password")>` starts encoding the password at some byte offset,
 * and base64 packs THREE bytes into four characters — so the password's standalone base64 is not a
 * substring of that blob unless the offset happens to be a multiple of three. Encoding it at all
 * three alignments and keeping only the characters whose bits come from the secret's own bytes gives
 * one needle per alignment, and one of the three always matches whatever was wrapped around it.
 * `start` is the first uncontaminated character for that alignment; `trailing` drops the characters
 * the encoder padded with zero bits instead of the byte that really follows the secret.
 */
function base64Windows(secret: string): string[] {
    const windows: string[] = []
    for (let align = 0; align < 3; align += 1) {
        const encoded = Buffer.from(' '.repeat(align) + secret, 'utf8')
            .toString('base64')
            .replace(/=+$/, '')
        const start = [0, 2, 3][align] ?? 0
        const trailing = [0, 2, 1][(align + Buffer.byteLength(secret, 'utf8')) % 3] ?? 0
        const window = encoded.slice(start, encoded.length - trailing)
        if (window.length >= MIN_BASE64_WINDOW) windows.push(window)
    }
    return windows
}

/**
 * Every spelling of a secret that can appear in serialized text.
 *
 * The scrubber runs over text someone else already encoded, not over the value this module was
 * handed, so the needle has to be looked for in the form that text uses. Six encodings, each one
 * something the kit or a partner's own code plausibly produces:
 *
 *  - raw — a connection string, a forwarded error message, `connecting with <key>`.
 *  - JSON-escaped — a password holding `"`, `\` or a newline is escaped inside the line pino wrote.
 *  - `encodeURIComponent` — `new URL()` re-encodes userinfo, and node's `fetch` puts the WHOLE url,
 *    password included, into its exception message. That leak was reproduced in this plan.
 *  - `encodeURI` — leaves `@` and `+` RAW while encoding space and `"`, so it matches neither of the
 *    two above.
 *  - form encoding — `URLSearchParams.toString()` writes a space as `+`, not `%20`.
 *  - base64 windows — see `base64Windows`.
 *
 * Nothing here parses a URL. `mqtt://user:secret@host` is a URL whose SCHEME naive parsing reads as
 * `user:`, and every repair for that ends up holding the credentials; substring replacement never
 * has to look at them.
 */
function spellings(secret: string): string[] {
    const out = [secret, JSON.stringify(secret).slice(1, -1)]
    try {
        const component = encodeURIComponent(secret)
        out.push(component, component.replaceAll('%20', '+'), encodeURI(secret))
    } catch {
        // A lone surrogate cannot be percent-encoded. The raw and JSON spellings still stand.
    }
    out.push(...base64Windows(secret))
    return out.filter((spelling) => spelling.length >= MIN_NEEDLE_LENGTH)
}

/**
 * Value-level redaction. Length is NOT the test: a five-character broker password is a bad password,
 * not a public one, and skipping short needles let exactly the credentials most likely to leak
 * through. The floor is 4 characters, which only exists to stop a stray empty or one-character entry
 * from turning every line into `[redacted]`; anything shorter is not a credential, it is a typo.
 * Longest needle first, so a spelling that contains another one wins.
 */
function scrubber(secrets: string[]): (line: string) => string {
    const needles = [...new Set(secrets.filter((s) => s.length >= MIN_NEEDLE_LENGTH).flatMap(spellings))].sort(
        (a, b) => b.length - a.length,
    )
    if (needles.length === 0) return (line) => line
    return (line) => {
        let out = line
        // `includes` before `split`/`join`. The empty-needle short-circuit above only fires when the
        // process has no secrets at all, which never happens in production — `REMI_API_KEY` is always
        // set — so without this every one of ~18 needles allocated an array and rejoined it for every
        // string on the bus, `botId` and `door: 'closed'` included. Identical semantics (`split` on a
        // needle that is not there returns a one-element array that rejoins to the same string) for
        // roughly a third of the cost.
        for (const needle of needles) if (out.includes(needle)) out = out.split(needle).join(REDACTED)
        return out
    }
}

export function createLogger(level: LogLevel, bus: EventBus, opts: LoggerOptions): Logger {
    const scrub = scrubber(opts.secrets)
    const write = opts.write ?? ((line: string) => void process.stderr.write(line))

    /**
     * THE ONE CHOKE POINT. Wrapped before anything else runs, and before the inner emit, so the
     * replay buffer, every `on`/`onAny` handler, the TUI's model and the SSE stream all see the
     * redacted copy — including the payloads a partner's driver emits through the `log(message,
     * data)` seam in `bot-runtime.ts`, which never touch pino.
     *
     * Wrapping an object the caller owns is a real side effect, so: it is idempotent in effect (a
     * second `createLogger` on the same bus chains a second scrubber, which redacts MORE, never
     * less), and `start.ts` calls this immediately after `createEventBus()` with nothing emitted in
     * between, so no payload is ever buffered unredacted.
     */
    const emit = bus.emit
    bus.emit = <K extends EventName>(name: K, payload: KitEvents[K]) => {
        emit.call(bus, name, redactPayload(payload, scrub) as KitEvents[K])
    }

    const destination = {
        write(raw: string) {
            const line = scrub(raw)
            try {
                const parsed = JSON.parse(line) as { level: number; msg?: string; botId?: string; [k: string]: unknown }
                const { level: n, msg, time: _t, pid: _p, hostname: _h, ...data } = parsed
                const lvl: LogLevel = n >= 50 ? 'error' : n >= 40 ? 'warn' : n >= 30 ? 'info' : 'debug'
                bus.emit('log', {
                    level: lvl,
                    message: msg ?? '',
                    botId: typeof parsed.botId === 'string' ? parsed.botId : undefined,
                    data,
                })
            } catch {
                bus.emit('log', { level: 'info', message: line.trim() })
            }
            // Nothing is written to stderr from here: everything goes onto the bus, and the bus
            // subscription below is the ONE place that writes. Writing in both would double every
            // direct `log.info()` line in headless mode.
        },
    }
    const logger = pino({ level, redact: { paths: REDACT_PATHS, censor: REDACTED }, base: undefined }, destination)

    /**
     * `--headless` has no TUI and no dashboard, so stderr is the only output — and almost everything
     * the kit reports (dropped states, command outcomes, link changes, transport errors) is emitted
     * on the BUS by the core, never through this logger object. Without this subscription
     * `efk start --headless` printed NOTHING at all while the fleet ran, which is the one mode where
     * there is nothing else to look at. With `sink: 'bus'` (the TUI is mounted) nobody writes: a byte
     * on stdout or stderr tears the screen.
     */
    if (opts.sink === 'stderr') {
        bus.on('log', (entry) => {
            if (LEVEL_VALUE[entry.level] < LEVEL_VALUE[level]) return
            const payload = {
                level: LEVEL_VALUE[entry.level],
                msg: entry.message,
                ...(entry.botId ? { botId: entry.botId } : {}),
                ...(entry.data ?? {}),
            }
            // The entry arrived redacted (the emit wrapper above); this is the last gate before the
            // bytes leave the process, and it costs one pass over a line that was about to be written.
            write(`${scrub(JSON.stringify(payload))}\n`)
        })
    }

    return logger
}
