import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { PAGE_HTML } from './page'

/**
 * This file does NOT call any exported helper directly — `page.ts` exports only `PAGE_HTML`, a
 * string, on purpose (it is plain HTML plus a `<script>`, nothing importable). The
 * project's own lesson is that a suite that only calls functions never
 * exercises the seam a reader lives through: the browser parses the real skeleton, runs the real
 * `<script>` text against it, a real click bubbles through `closest()`, and a real `fetch()` POST
 * comes back before anything re-renders. So this harness builds a tiny DOM out of the ACTUAL
 * `PAGE_HTML` string (extracted, not retyped) and runs the ACTUAL script text in a `vm` context
 * against it — a bug in the shipped markup or script is exactly what would fail here.
 */

type Attrs = Record<string, string>

class FakeText {
    constructor(public text: string) {}
    get textContent() {
        return this.text
    }
    set textContent(v: string) {
        this.text = v
    }
}

class FakeElement {
    tagName: string
    attrs: Attrs
    children: Array<FakeElement | FakeText> = []
    parent: FakeElement | null = null
    private raw = ''
    private listeners: Record<string, (e: { target: FakeElement }) => void> = {}

    constructor(tagName: string, attrs: Attrs) {
        this.tagName = tagName.toLowerCase()
        this.attrs = attrs
    }

    get id() {
        return this.attrs.id ?? ''
    }

    get hidden() {
        return this.attrs.hidden !== undefined
    }
    set hidden(v: boolean) {
        if (v) this.attrs.hidden = ''
        else delete this.attrs.hidden
    }

    classList = {
        has: (c: string) => (this.attrs.class ?? '').split(/\s+/).filter(Boolean).includes(c),
        contains: (c: string) => this.classList.has(c),
        add: (c: string) => {
            const s = new Set((this.attrs.class ?? '').split(/\s+/).filter(Boolean))
            s.add(c)
            this.attrs.class = [...s].join(' ')
        },
        remove: (c: string) => {
            const s = new Set((this.attrs.class ?? '').split(/\s+/).filter(Boolean))
            s.delete(c)
            this.attrs.class = [...s].join(' ')
        },
        toggle: (c: string, force?: boolean) => {
            const want = force === undefined ? !this.classList.has(c) : force
            if (want) this.classList.add(c)
            else this.classList.remove(c)
        },
    }

    get dataset(): Record<string, string | undefined> {
        const attrs = this.attrs
        return new Proxy(
            {},
            {
                get(_t, prop: string) {
                    return attrs[`data-${prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`]
                },
            },
        )
    }

    get firstChild(): FakeText | FakeElement | undefined {
        return this.children[0]
    }

    get textContent(): string {
        return this.children.map((c) => c.textContent).join('')
    }
    set textContent(v: string) {
        this.children = [new FakeText(v)]
    }

    get innerHTML(): string {
        return this.raw
    }
    set innerHTML(html: string) {
        this.raw = html
        this.children = parseInto(this, html)
    }

    addEventListener(type: string, fn: (e: { target: FakeElement }) => void) {
        this.listeners[type] = fn
    }
    fire(type: string, event: { target: FakeElement }) {
        this.listeners[type]?.(event)
    }

    private matchesSimple(sel: string): boolean {
        if (sel.startsWith('#')) return this.id === sel.slice(1)
        const m = sel.match(/^([a-zA-Z0-9-]*)(?:\[([a-zA-Z0-9-]+)])?$/)
        if (!m) return false
        const [, tag, attr] = m
        if (tag && this.tagName !== tag) return false
        if (attr && !(attr in this.attrs)) return false
        return true
    }

    closest(sel: string): FakeElement | null {
        let n: FakeElement | null = this
        while (n) {
            if (n.matchesSimple(sel)) return n
            n = n.parent
        }
        return null
    }

    private descendantsOrSelf(): FakeElement[] {
        const out: FakeElement[] = [this]
        for (const c of this.children) if (c instanceof FakeElement) out.push(...c.descendantsOrSelf())
        return out
    }

    querySelectorAll(sel: string): FakeElement[] {
        const parts = sel.trim().split(/\s+/)
        let ctxs: FakeElement[] = [this]
        for (const part of parts) {
            const next: FakeElement[] = []
            for (const ctx of ctxs) next.push(...ctx.descendantsOrSelf().filter((el) => el !== ctx && el.matchesSimple(part)))
            // the first part is allowed to match the root itself (e.g. an id on the container)
            if (part === parts[0]) next.push(...ctxs.filter((el) => el.matchesSimple(part)))
            ctxs = next
        }
        return ctxs
    }

    findByAttr(name: string, value: string): FakeElement | null {
        for (const el of this.descendantsOrSelf()) if (el.attrs[name] === value) return el
        return null
    }
}

/** Parses our own generated markup (no self-closing tags anywhere in it — every element in `page.ts` is explicitly closed) into a tree, wiring `.parent` so `closest()` walks a real chain. */
function parseInto(parent: FakeElement, html: string): Array<FakeElement | FakeText> {
    const root: Array<FakeElement | FakeText> = []
    const stack: FakeElement[] = []
    const push = (node: FakeElement | FakeText) => {
        const top = stack[stack.length - 1]
        ;(top ? top.children : root).push(node)
    }
    let i = 0
    while (i < html.length) {
        if (html.startsWith('<!--', i)) {
            const end = html.indexOf('-->', i)
            i = end < 0 ? html.length : end + 3
            continue
        }
        if (html[i] === '<') {
            if (html[i + 1] === '/') {
                const end = html.indexOf('>', i)
                stack.pop()
                i = end + 1
                continue
            }
            const end = html.indexOf('>', i)
            const content = html.slice(i + 1, end)
            const selfClose = content.endsWith('/')
            const clean = selfClose ? content.slice(0, -1) : content
            const tagMatch = clean.match(/^([a-zA-Z0-9-]+)/)
            const tagName = tagMatch?.[1] ?? ''
            const attrsStr = clean.slice(tagName.length)
            const attrs: Attrs = {}
            const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g
            let am: RegExpExecArray | null
            // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop
            while ((am = attrRe.exec(attrsStr))) {
                const key = am[1]
                if (key) attrs[key] = am[2] ?? ''
            }
            const el = new FakeElement(tagName, attrs)
            const top = stack[stack.length - 1]
            el.parent = top ?? parent
            push(el)
            if (!selfClose) stack.push(el)
            i = end + 1
            continue
        }
        const nextLt = html.indexOf('<', i)
        const textEnd = nextLt === -1 ? html.length : nextLt
        const raw = html.slice(i, textEnd)
        if (raw.length) push(new FakeText(raw))
        i = textEnd
    }
    return root
}

/** Builds a runnable page: the real skeleton HTML parsed, and the real `<script>` body run in a `vm` context against it, with `fetch`/`EventSource`/`window.location` stubbed. */
function mountPage(fetchQueue: Array<{ ok: boolean; body: unknown }>) {
    const bodyMatch = PAGE_HTML.match(/<body>([\s\S]*?)<script>/)
    const scriptMatch = PAGE_HTML.match(/<script>([\s\S]*?)<\/script>/)
    if (!bodyMatch || !scriptMatch) throw new Error('PAGE_HTML lost its <body>/<script> shape')
    const container = new FakeElement('div', {})
    container.innerHTML = bodyMatch[1] ?? ''

    const fetchCalls: string[] = []
    const fetchStub = (url: string) => {
        fetchCalls.push(url)
        const entry = fetchQueue.shift()
        if (!entry) throw new Error(`unexpected fetch: ${url}`)
        return Promise.resolve({ ok: entry.ok, json: () => Promise.resolve(entry.body) })
    }

    class FakeEventSource {
        listeners: Record<string, (e: { data: string }) => void> = {}
        onerror: (() => void) | null = null
        addEventListener(type: string, fn: (e: { data: string }) => void) {
            this.listeners[type] = fn
        }
    }

    const sandbox: Record<string, unknown> = {
        document: {
            getElementById: (id: string) => container.findByAttr('id', id),
            querySelectorAll: (sel: string) => container.querySelectorAll(sel),
        },
        window: { location: { host: 'localhost:4410' } },
        fetch: fetchStub,
        EventSource: FakeEventSource,
        console,
        encodeURIComponent,
        Date,
        JSON,
        Math,
    }
    vm.createContext(sandbox)
    vm.runInContext(scriptMatch[1] ?? '', sandbox)

    return { container, sandbox, fetchCalls }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function baseSnapshot(overrides: Record<string, unknown> = {}) {
    return {
        namespace: 'acme',
        demo: false,
        controlsEnabled: true,
        bots: [],
        commands: [],
        events: [],
        log: [],
        ...overrides,
    }
}

describe('the dashboard page (rendered against the real PAGE_HTML skeleton + script)', () => {
    it('renders bot rows from a snapshot', async () => {
        const snapshot = baseSnapshot({
            bots: [
                {
                    botId: 'ACME-0001',
                    connected: true,
                    available: true,
                    batteryPercentage: 84,
                    door: 'closed',
                    command: '9f2a executing',
                    lastPublishedAgeMs: 2000,
                    seq: 41207,
                    dropped: 0,
                    hasControls: true,
                    hasDoor: true,
                },
                {
                    botId: 'ACME-0002',
                    connected: false,
                    available: false,
                    batteryPercentage: 17,
                    door: 'stalled',
                    command: '—',
                    lastPublishedAgeMs: null,
                    seq: null,
                    dropped: 3,
                    hasControls: true,
                    hasDoor: true,
                },
            ],
        })
        const { container } = mountPage([{ ok: true, body: snapshot }])
        await flush()
        const tablewrap = container.findByAttr('id', 'tablewrap') as FakeElement
        const html = tablewrap.innerHTML
        assert.match(html, /ACME-0001/)
        assert.match(html, /ACME-0002/)
        assert.match(html, /84%/)
        assert.match(html, /stalled/)
        assert.equal((container.findByAttr('id', 'statOf') as FakeElement).textContent, '/2')
    })

    it('controlsEnabled: false renders no control buttons', async () => {
        const snapshot = baseSnapshot({
            controlsEnabled: false,
            bots: [
                {
                    botId: 'ACME-0001',
                    connected: true,
                    available: true,
                    batteryPercentage: 84,
                    door: 'closed',
                    command: '—',
                    lastPublishedAgeMs: 2000,
                    seq: 1,
                    dropped: 0,
                    hasControls: true,
                    hasDoor: true,
                },
            ],
        })
        const { container } = mountPage([{ ok: true, body: snapshot }])
        await flush()
        // Select a controllable bot anyway — controlsEnabled: false must win regardless of
        // selection, not just when nothing is picked yet.
        const tablewrap = container.findByAttr('id', 'tablewrap') as FakeElement
        const row = tablewrap.findByAttr('data-botid', 'ACME-0001') as FakeElement
        tablewrap.fire('click', { target: row })
        const bar = container.findByAttr('id', 'controlbar') as FakeElement
        assert.doesNotMatch(bar.innerHTML, /data-act=/)
        assert.match(bar.innerHTML, /off/i)
    })

    it('a refused "available" toggle shows its note', async () => {
        const bot = {
            botId: 'ACME-0003',
            connected: true,
            available: false,
            batteryPercentage: 12,
            door: 'closed',
            command: '—',
            lastPublishedAgeMs: 500,
            seq: 9,
            dropped: 0,
            hasControls: true,
            hasDoor: true,
        }
        const snapshot = baseSnapshot({ bots: [bot] })
        const { container, sandbox } = mountPage([
            { ok: true, body: snapshot },
            {
                ok: true,
                body: { ok: true, requested: true, applied: false, note: `ACME-0003 refused: only 12% battery, can't go available.` },
            },
        ])
        await flush()

        // Select the row by clicking a deeply nested child, proving closest() bubbling — not a
        // direct function call.
        const tablewrap = container.findByAttr('id', 'tablewrap') as FakeElement
        const botCode = tablewrap.findByAttr('class', 'ink strong') as FakeElement
        tablewrap.fire('click', { target: botCode })

        const bar = container.findByAttr('id', 'controlbar') as FakeElement
        const availPill = bar.findByAttr('data-act', 'available') as FakeElement
        assert.ok(availPill, 'available pill should render once a controllable bot is selected')
        const keyChip = availPill.findByAttr('class', 'key') as FakeElement
        bar.fire('click', { target: keyChip })
        await flush()

        assert.match(bar.innerHTML, /refused: only 12% battery/)
        assert.equal(sandbox.S && (sandbox.S as { note: string }).note.includes('refused'), true)
    })

    it('a doorless bot shows the door control disabled with its reason, and a link toggle marks the row with *', async () => {
        const bot = {
            botId: 'ACME-0004',
            connected: true,
            available: true,
            batteryPercentage: 91,
            door: 'unsupported',
            command: '—',
            lastPublishedAgeMs: 100,
            seq: 3,
            dropped: 0,
            hasControls: true,
            hasDoor: false,
        }
        const snapshot = baseSnapshot({ bots: [bot] })
        const { container, fetchCalls } = mountPage([
            { ok: true, body: snapshot },
            { ok: true, body: { ok: true, pin: true, connected: true, label: 'up*', note: null } },
        ])
        await flush()

        const tablewrap = container.findByAttr('id', 'tablewrap') as FakeElement
        const row = tablewrap.findByAttr('data-botid', 'ACME-0004') as FakeElement
        tablewrap.fire('click', { target: row })

        const bar = container.findByAttr('id', 'controlbar') as FakeElement
        const doorPill = bar.findByAttr('data-act', 'door') as FakeElement
        assert.ok((doorPill.attrs.class ?? '').includes('disabled'))
        bar.fire('click', { target: doorPill })
        assert.match(bar.innerHTML, /has no door/)
        assert.equal(fetchCalls.filter((u) => u.includes('/controls/door')).length, 0, 'a disabled door click must not hit the network')

        const linkPill = bar.findByAttr('data-act', 'link') as FakeElement
        bar.fire('click', { target: linkPill })
        await flush()
        assert.match(bar.innerHTML, /link/)

        const refreshedRow = tablewrap.findByAttr('data-botid', 'ACME-0004') as FakeElement
        assert.match(refreshedRow.textContent, /up\*/)
    })
})
