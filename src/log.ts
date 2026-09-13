/**
 * pino with two guarantees the design asks for (§8): secrets never reach a sink — by key (redact paths)
 * and by value (a scrubber over the serialized line, because a token inside a free-text message has no
 * key) — and every line is mirrored onto the bus so the TUI's LOG section and the web dashboard see it.
 * With the TUI mounted the sink is the bus alone: anything written to stdout would tear the screen.
 */
import pino, { type Logger } from 'pino'
import type { EventBus } from './core/events'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LoggerOptions = {
    sink: 'stderr' | 'bus'
    secrets: string[]
    /** Injected in tests; defaults to process.stderr.write. */
    write?: (line: string) => void
}

const LEVEL_VALUE: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 }

/**
 * Keys whose VALUE is never printed, whatever it is. The first block is the kit's own `.env` names;
 * the second is the generic shape a future call site will reach for, because every option object in
 * this repo that carries a credential calls it exactly one of these — `password` (the MQTT
 * connection and probe options), `token` (the HTTP transport and server), `apiKey` (`createRemiClient`),
 * `secret`. Value-level scrubbing below only knows the three secrets `start.ts` hands it; these paths
 * are what catch a credential that never went through `.env` at all.
 */
const REDACT_PATHS = [
    'authorization',
    '*.authorization',
    'headers.authorization',
    'REMI_API_KEY',
    'MQTT_PASSWORD',
    'HTTP_TOKEN',
    '*.REMI_API_KEY',
    '*.MQTT_PASSWORD',
    '*.HTTP_TOKEN',
    'env.REMI_API_KEY',
    'env.MQTT_PASSWORD',
    'env.HTTP_TOKEN',
    'password',
    'token',
    'apiKey',
    'secret',
    '*.password',
    '*.token',
    '*.apiKey',
    '*.secret',
]

/**
 * Every spelling of a secret that can appear in a serialized line.
 *
 * The scrubber runs over the JSON pino produced, not over the values it was handed, so the needle has
 * to be looked for in the form JSON writes: a password holding a quote, a backslash or a newline is
 * ESCAPED there, and searching for the raw characters would sail straight past it. Percent-encoding is
 * the same trap one layer out — `new URL()` re-encodes userinfo, so the password in the message Node's
 * `fetch` builds from a URL is the encoded spelling, not the one in `.env`.
 *
 * None of these variants is derived by parsing anything: `mqtt://user:secret@host` parses as a URL
 * whose SCHEME is `user:`, and every repair for that ends up handling the credentials. Plain substring
 * replacement never has to look at them.
 */
function spellings(secret: string): string[] {
    const encoded = (() => {
        try {
            return encodeURIComponent(secret)
        } catch {
            return secret
        }
    })()
    return [secret, JSON.stringify(secret).slice(1, -1), encoded]
}

/**
 * Value-level redaction. Length is NOT the test: a five-character broker password is a bad password,
 * not a public one, and skipping short needles let exactly the credentials most likely to leak
 * through. The floor is 4 characters, which only exists to stop a stray empty or one-character entry
 * from turning every line into `[redacted]`; anything shorter is not a credential, it is a typo.
 */
function scrubber(secrets: string[]): (line: string) => string {
    const needles = [...new Set(secrets.filter((s) => s.length >= 4).flatMap(spellings))].sort((a, b) => b.length - a.length)
    return (line) => needles.reduce((acc, s) => acc.split(s).join('[redacted]'), line)
}

export function createLogger(level: LogLevel, bus: EventBus, opts: LoggerOptions): Logger {
    const scrub = scrubber(opts.secrets)
    const write = opts.write ?? ((line: string) => void process.stderr.write(line))
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
    const logger = pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' }, base: undefined }, destination)

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
            write(`${scrub(JSON.stringify(payload))}\n`)
        })
    }

    return logger
}
