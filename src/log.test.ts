import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import type { BotState } from './contract/schemas'
import { createEventBus } from './core/events'
import { createLogger } from './log'

/** What the bus carried, unflattened, so a test can assert on the exact property instead of a substring. */
function recorder() {
    const entries: Array<{ level: string; message: string; botId?: string; data?: Record<string, unknown> }> = []
    const bus = createEventBus()
    bus.on('log', (l) => entries.push({ level: l.level, message: l.message, botId: l.botId, data: l.data }))
    return { bus, entries }
}

describe('logger', () => {
    it('redacts secret keys and secret values, and mirrors lines onto the bus', () => {
        const bus = createEventBus()
        const seen: string[] = []
        bus.on('log', (l) => seen.push(`${l.level} ${l.message} ${JSON.stringify(l.data ?? {})}`))
        const key = 'live_sk_000000000000000000000000000000000000000000000000'
        const log = createLogger('debug', bus, { sink: 'bus', secrets: [key, 'hunter2hunter2hunter2hunter2hunter2'] })
        log.info(
            { headers: { authorization: `Bearer ${key}` }, REMI_API_KEY: key, MQTT_PASSWORD: 'hunter2hunter2hunter2hunter2hunter2' },
            `connecting with ${key}`,
        )
        assert.equal(seen.length, 1)
        assert.doesNotMatch(seen[0] ?? '', /live_sk_0{48}/)
        assert.doesNotMatch(seen[0] ?? '', /hunter2/)
        assert.match(seen[0] ?? '', /\[redacted\]/)
    })
    it('respects the level', () => {
        const bus = createEventBus()
        let count = 0
        bus.on('log', () => count++)
        const log = createLogger('warn', bus, { sink: 'bus', secrets: [] })
        log.info('hidden')
        log.warn('shown')
        assert.equal(count, 1)
    })
    it('redacts a short secret too: length is not what makes a value secret', () => {
        const bus = createEventBus()
        const seen: string[] = []
        bus.on('log', (l) => seen.push(l.message))
        // A broker password of 5 characters is a bad password, not a public one. The scrubber used to
        // skip anything under 8 chars, so exactly the credentials most likely to leak went through.
        createLogger('debug', bus, { sink: 'bus', secrets: ['hunt', 'x'] }).info('connecting with hunt')
        assert.doesNotMatch(seen[0] ?? '', /hunt/)
        assert.match(seen[0] ?? '', /\[redacted\]/)
    })
    it('sink: stderr writes one JSON line per bus event, which is what --headless needs', () => {
        const bus = createEventBus()
        const lines: string[] = []
        const log = createLogger('info', bus, { sink: 'stderr', secrets: [], write: (line) => lines.push(line) })
        // Everything the core reports goes through the BUS, not through this logger object: if the
        // logger only wrote what someone called `log.info()` on, `efk start --headless` printed
        // nothing at all while the fleet ran — the exact mode where there is no TUI to look at.
        bus.emit('log', { level: 'warn', botId: 'ACME-0001', message: 'state dropped for ACME-0001: position is null' })
        assert.equal(lines.length, 1)
        const parsed = JSON.parse(lines[0] ?? '{}') as { level: string; msg: string; botId: string }
        assert.equal(parsed.msg, 'state dropped for ACME-0001: position is null')
        assert.equal(parsed.botId, 'ACME-0001')
        log.info('and a direct call still works')
        assert.equal(lines.length, 2)
    })

    it('redacts BY KEY a credential it was never handed: `secrets` is empty here', () => {
        const { bus, entries } = recorder()
        // Nothing below can be caught by value — the scrubber has no needles. What saves the line is
        // the KEY the call site used, which is the half that covers a credential that never came
        // through `.env`: every option object in this repo spells one `password`, `token`, `apiKey`
        // or `authorization`, so this is the shape a future call site will hand over by accident.
        const log = createLogger('debug', bus, { sink: 'bus', secrets: [] })
        log.info(
            { broker: { host: 'broker.invalid', port: 8883, password: 'p4ssw0rd-from-nowhere' }, apiKey: 'live_sk_from_nowhere' },
            'connecting',
        )
        assert.equal(entries.length, 1)
        const entry = entries[0]
        assert.ok(entry)
        const data = entry.data as { broker: { host: string; port: number; password: string }; apiKey: string }
        // Absent AND present: the censor is in place of the value, not in place of the whole object.
        // An absence check on its own would pass just as happily against a logger that logged nothing.
        assert.equal(data.broker.password, '[redacted]')
        assert.equal(data.apiKey, '[redacted]')
        assert.equal(data.broker.host, 'broker.invalid')
        assert.equal(data.broker.port, 8883)
        assert.equal(entry.message, 'connecting')
        assert.doesNotMatch(JSON.stringify(entry), /p4ssw0rd-from-nowhere/)
        assert.doesNotMatch(JSON.stringify(entry), /live_sk_from_nowhere/)
    })

    it('redacts BY VALUE inside strings that carry no revealing key: a URL with userinfo and a free-text detail', () => {
        const { bus, entries } = recorder()
        // Quote and space on purpose: the scrubber runs over the JSON pino wrote, where this password
        // is escaped, and over a URL, where it is percent-encoded. A needle that only knew the raw
        // spelling would sail past both — and `fetch` putting the WHOLE url, password included, into
        // its exception message is a leak this plan already reproduced once.
        const password = 'br0ker-p@ss word"quoted'
        const url = `mqtts://fleetuser:${encodeURIComponent(password)}@broker.invalid:8883`
        const log = createLogger('debug', bus, { sink: 'bus', secrets: [password] })
        log.error({ detail: `CONNECT refused for ${password}` }, `fetch failed: ${url}`)
        assert.equal(entries.length, 1)
        const entry = entries[0]
        assert.ok(entry)
        // Positive: the host, the port and the username are still there, so the line is still worth
        // reading — the credentials are gone and nothing else is. Note the repair never parses the
        // URL: `mqtts://user:secret@host` is a URL whose scheme naive parsing reads as `user:`, and
        // every fix for that ends up holding the credentials.
        assert.equal(entry.message, 'fetch failed: mqtts://fleetuser:[redacted]@broker.invalid:8883')
        assert.equal((entry.data as { detail: string }).detail, 'CONNECT refused for [redacted]')
        assert.equal(entry.level, 'error')
        assert.doesNotMatch(JSON.stringify(entry), /br0ker-p/)
        assert.doesNotMatch(JSON.stringify(entry), /quoted/)
    })

    it('redacts a payload emitted STRAIGHT ONTO THE BUS by a partner driver, at any depth', () => {
        const { bus, entries } = recorder()
        createLogger('debug', bus, { sink: 'bus', secrets: ['fleet-broker-password'] })
        // This is `bot-runtime.ts`'s `log: (message, data) => bus.emit('log', { …, data })` — the
        // seam handed to a driver THIS REPO DID NOT WRITE. It never touches the `Logger` object, so
        // pino's serializer never sees it; with the TUI mounted it goes to the screen and, through
        // `onAny`, to every `/events` subscriber. Redaction that lived only in pino protected the
        // one route whose author we control and left this one, the third-party one, wide open.
        bus.emit('log', {
            level: 'info',
            botId: 'ACME-0001',
            message: 'reconnecting to mqtt://fleet:fleet-broker-password@broker.invalid',
            data: { attempt: 3, broker: { auth: { password: 'never-given-to-the-logger' } } },
        })
        assert.equal(entries.length, 1)
        const entry = entries[0]
        assert.ok(entry)
        const data = entry.data as { attempt: number; broker: { auth: { password: string } } }
        // Three levels down, and `*.password` only reaches one — this is what the recursive pass buys.
        assert.equal(data.broker.auth.password, '[redacted]')
        assert.equal(entry.message, 'reconnecting to mqtt://fleet:[redacted]@broker.invalid')
        // Paired positives: the line still says who, what and how many attempts.
        assert.equal(data.attempt, 3)
        assert.equal(entry.botId, 'ACME-0001')
        assert.equal(entry.level, 'info')
        assert.doesNotMatch(JSON.stringify(entry), /never-given-to-the-logger/)
        assert.doesNotMatch(JSON.stringify(entry), /fleet-broker-password/)
    })

    it('redacts a secret spelled in base64, as an HTTP Basic header carries it', () => {
        const { bus, entries } = recorder()
        const password = 'sup3r-secret-broker-pass'
        // base64 packs THREE bytes into four characters, so `base64('fleetuser:' + password)` does
        // not contain `base64(password)` — the spelling depends on the byte offset. A needle that
        // only knew the aligned form would let a whole Basic header through untouched.
        const blob = Buffer.from(`fleetuser:${password}`, 'utf8').toString('base64')
        createLogger('debug', bus, { sink: 'bus', secrets: [password] }).warn(`upstream said 401 for Authorization: Basic ${blob}`)
        const entry = entries[0]
        assert.ok(entry)
        // One assertion doing both jobs: the sentence in front survived verbatim (so this is not an
        // empty string passing an absence check), and at most a few base64 characters remain on
        // either side of the censor — the bytes that spell the password are gone.
        assert.match(entry.message, /^upstream said 401 for Authorization: Basic [A-Za-z0-9+/]{0,16}\[redacted\][A-Za-z0-9+/=]{0,6}$/)
        assert.equal(entry.message.includes(blob), false)
        assert.equal(entry.level, 'warn')
    })

    it('redacts the two encodings that differ from encodeURIComponent: encodeURI and form encoding', () => {
        const { bus, entries } = recorder()
        // `@` and `+` stay RAW under encodeURI while a space becomes `%20`; `URLSearchParams` writes
        // that same space as `+` and the `+` as `%2B`. Neither spelling matches the raw secret, and
        // neither matches `encodeURIComponent` either.
        const password = 'p@ss w0rd+x'
        const log = createLogger('debug', bus, { sink: 'bus', secrets: [password] })
        log.info(
            {
                url: `https://remi.invalid/login?pw=${encodeURI(password)}`,
                // Deliberately NOT a key the key layer knows, so only value redaction can save it.
                body: new URLSearchParams({ pw_in_body: password }).toString(),
            },
            'callback failed',
        )
        const entry = entries[0]
        assert.ok(entry)
        const data = entry.data as { url: string; body: string }
        // Exact strings: the endpoint, the query parameter name and the form field name all survive.
        assert.equal(data.url, 'https://remi.invalid/login?pw=[redacted]')
        assert.equal(data.body, 'pw_in_body=[redacted]')
        assert.equal(entry.message, 'callback failed')
        assert.doesNotMatch(JSON.stringify(entry), /w0rd/)
    })

    it('leaves a contract payload byte-for-byte alone: redaction sits on EVERY event, not just log', () => {
        // The emit wrapper rewrites every payload on the bus, and `state.published` is the hottest
        // one (200 bots, four times a second). A redactor that quietly reshaped a `BotState` — a
        // number to a string, a nested object to `{}`, a key dropped — would corrupt what the TUI,
        // the dashboard and `/events` report about a real fleet, with nothing to point at.
        // The frozen sample is the same one the parity suite validates against the schema.
        const state = JSON.parse(
            readFileSync(new URL('./contract/samples/type-bot-state__botstate.json', import.meta.url), 'utf8'),
        ) as BotState
        const bus = createEventBus()
        const seen: Array<{ botId: string; state: BotState; transport: string }> = []
        bus.on('state.published', (p) => seen.push(p))
        createLogger('debug', bus, { sink: 'bus', secrets: ['live_sk_0000000000000000'] })
        bus.emit('state.published', { botId: state.bot_id, state, transport: 'mqtt' })
        assert.equal(seen.length, 1)
        assert.deepEqual(seen[0]?.state, state)
        assert.equal(seen[0]?.botId, 'ACME-0142')
        assert.equal(seen[0]?.transport, 'mqtt')
        // The types survived, not only the shape: `deepEqual` on a JSON round-trip would not notice
        // a number that had become its own string.
        assert.equal(typeof seen[0]?.state.seq, 'number')
        assert.equal(seen[0]?.state.current_command?.id, 'GW-5867/pickup')
    })
})
