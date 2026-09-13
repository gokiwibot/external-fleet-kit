import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { createEventBus, type EventBus } from '../core/events'
import type { FleetManager } from '../core/fleet-manager'
import { createWebApp, startWeb } from './index'

const manager = {
    bots: () => [],
    config: () => null,
    capabilities: () => ({ supports_command_interrupt: true, default: { has_door: true, supported_commands: [] } }),
    driver: () => undefined,
} as unknown as FleetManager

/**
 * A bus that counts its live `onAny` subscriptions. That count is the observable form of "the
 * dashboard let go": `createWebApp` takes exactly one to fold every event into its model, and
 * `close()` is what gives it back.
 */
function countingBus(): { bus: EventBus; live: () => number } {
    const inner = createEventBus()
    let live = 0
    return {
        bus: {
            ...inner,
            onAny: (handler) => {
                live += 1
                const off = inner.onAny(handler)
                let released = false
                return () => {
                    if (!released) {
                        released = true
                        live -= 1
                    }
                    off()
                }
            },
        },
        live: () => live,
    }
}

describe('web dashboard', () => {
    it('serves the page and a JSON snapshot', async () => {
        const app = createWebApp({ bus: createEventBus(), manager })
        const page = await app.request('/')
        assert.equal(page.status, 200)
        assert.match(page.headers.get('content-type') ?? '', /text\/html/)
        assert.match(await page.text(), /EventSource\('\/events'\)/)
        const snap = await app.request('/api/snapshot')
        assert.equal(snap.status, 200)
        assert.deepEqual(Object.keys((await snap.json()) as object).sort(), ['bots', 'commands', 'demo', 'events', 'log', 'namespace'])
    })
    it('the snapshot carries the demo flag the page needs to raise its red band', async () => {
        // `page.ts`'s `render()` reads `s.demo` and this is the FIRST thing it renders, before any
        // SSE has arrived. If the flag were missing here the DEMO band would depend entirely on the
        // stream connecting — and in demo mode nothing else on the page says the fleet is invented.
        const demo = createWebApp({ bus: createEventBus(), manager, demo: true })
        const onSnapshot = (await (await demo.request('/api/snapshot')).json()) as {
            demo: boolean
            namespace: string | null
            bots: unknown[]
        }
        assert.equal(onSnapshot.demo, true)
        // Paired: the rest of the payload is real, so `demo: true` is not all that survived.
        assert.equal(onSnapshot.namespace, null)
        assert.deepEqual(onSnapshot.bots, [])
        demo.close()

        const live = createWebApp({ bus: createEventBus(), manager })
        const offSnapshot = (await (await live.request('/api/snapshot')).json()) as { demo: boolean }
        assert.equal(offSnapshot.demo, false)
        live.close()
    })
    it('replays what the bus buffered before it mounted, DEMO MODE warning included', async () => {
        const bus = createEventBus()
        // Exactly the order `startWith` runs in: the demo banner is logged long before --web binds.
        bus.emit('log', { level: 'warn', message: 'DEMO MODE — not connected to remi.' })
        bus.emit('log', { level: 'info', message: 'fleet started' })
        const app = createWebApp({ bus, manager, demo: true })
        const snap = (await (await app.request('/api/snapshot')).json()) as { log: Array<{ level: string; message: string }> }
        // Newest first, both present, and the levels survived the replay.
        assert.deepEqual(
            snap.log.map((l) => `${l.level} ${l.message}`),
            ['info fleet started', 'warn DEMO MODE — not connected to remi.'],
        )
        app.close()
    })
    it('/events is an SSE stream: first a snapshot, then every bus event', async () => {
        const bus = createEventBus()
        const app = createWebApp({ bus, manager })
        const res = await app.request('/events')
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
        const reader = res.body?.getReader()
        assert.ok(reader)

        // The stream opens with `event: snapshot` (see createWebApp), so the first chunk is NOT the
        // log line. Read until the log event shows up instead of asserting on whatever arrived first.
        const decoder = new TextDecoder()
        const first = decoder.decode((await reader.read()).value)
        assert.match(first, /event: snapshot/)

        bus.emit('log', { level: 'info', message: 'hello sse' })
        let seen = ''
        for (let i = 0; i < 10 && !seen.includes('event: log'); i += 1) {
            const { value, done } = await reader.read()
            if (done) break
            seen += decoder.decode(value)
        }
        assert.match(seen, /event: log/)
        assert.match(seen, /hello sse/)
        await reader.cancel()
        app.close()
    })
    it('binds to 127.0.0.1 unless a host is given', async () => {
        const addresses: AddressInfo[] = []
        const stop = await startWeb({
            bus: createEventBus(),
            manager,
            host: '127.0.0.1',
            port: 0,
            demo: false,
            onListening: (addr) => addresses.push(addr),
        })
        assert.equal(addresses[0]?.address, '127.0.0.1')
        await stop()
    })
    it('warns when it is exposed beyond loopback', async () => {
        const bus = createEventBus()
        const warnings: string[] = []
        bus.on('log', (l) => warnings.push(l.message))
        const stop = await startWeb({ bus, manager, host: '0.0.0.0', port: 0, demo: false })
        assert.match(warnings.join('\n'), /keep it on 127\.0\.0\.1/)
        await stop()
    })
    it('stop() unsubscribes from the bus', async () => {
        const { bus, live } = countingBus()
        const stop = await startWeb({ bus, manager, host: '127.0.0.1', port: 0, demo: false })
        assert.equal(live(), 1)
        await stop()
        // Nothing throws and nothing accumulates: the app is gone, not still folding events into a
        // model that will never be read. Long-running `efk start` sessions restart the dashboard.
        assert.equal(live(), 0)
        bus.emit('log', { level: 'info', message: 'after stop' })
        assert.equal(live(), 0)
    })
})
