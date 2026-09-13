import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { BotCommand, BotEvent, BotState, CommandStatus, FleetCapabilities } from '../../contract/schemas'
import type { CommandOutcome } from '../../core/events'
import { createEventBus } from '../../core/events'
import { FakeClock, FakeDriver } from '../../core/fakes'
import { createFleetManager, type FleetManager } from '../../core/fleet-manager'
import { createSeq } from '../../core/seq'
import { createStateStore } from '../../core/state-store'
import type { RemiClient } from '../../remi/client'
import type { Transport } from '../transport'
import { createPartnerApp } from './server'

// Nothing outlives the run: every temp directory is removed and every manager stopped (which also
// flushes the seq file into that directory before it goes). `tickMs: 0` means no timer is ever armed.
const dirs: string[] = []
const managers: FleetManager[] = []
after(async () => {
    for (const manager of managers) await manager.stop()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const TOKEN = 'a'.repeat(32)

const config = {
    namespace: 'acme',
    bot_id_prefix: 'ACME-',
    transport: 'http' as const,
    base_url: null,
    token_set: true,
    poll_interval_active_ms: 2000,
    poll_interval_idle_ms: 15000,
    max_bots: 2,
    contract_version: '2026-09',
}

function fakeRemi(): RemiClient {
    return {
        getFleetConfig: async () => ({ ok: true, data: config }),
        listFleetBots: async () => ({
            ok: true,
            data: [
                {
                    bot_id: 'ACME-0001',
                    location_id: 'L',
                    assignable: false,
                    blocked_by: ['disconnected' as const],
                    state_age_ms: null,
                    current_job_id: null,
                },
            ],
        }),
        listDeliveries: async () => ({ ok: true, data: null }),
        createDelivery: async () => ({ ok: false, status: 0, code: 'X', message: '' }),
        getDelivery: async () => ({ ok: false, status: 0, code: 'X', message: '' }),
        pushState: async () => ({ ok: true, data: { accepted: 0, rejected: 0 } }),
        reportEvent: async () => ({ ok: true, data: { accepted: true } }),
    }
}

/** HTTP with push off — the default: nothing is ever published, so only `GET /bots` delivers anything. */
class PollingTransport implements Transport {
    readonly kind = 'http' as const
    handler: ((botId: string, command: BotCommand) => Promise<CommandOutcome>) | null = null
    capabilities: FleetCapabilities | null = null
    async start() {}
    async stop() {}
    async publishState(_botId: string, _state: BotState) {
        return false
    }
    async publishEvent(_botId: string, _event: BotEvent) {
        return false
    }
    async publishCapabilities(doc: FleetCapabilities) {
        this.capabilities = doc
    }
    async flushTick() {}
    onCommand(handler: (botId: string, command: BotCommand) => Promise<CommandOutcome>) {
        this.handler = handler
    }
}

/**
 * The app is built the way the transport builds it in production: `serve` is the MANAGER's, and the
 * commands go through the handler the manager registered. Assembling the states here instead would
 * answer every poll and never drain the ledger.
 */
async function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'efk-'))
    dirs.push(dir)
    const clock = new FakeClock()
    const driver = new FakeDriver('ACME-0001')
    const bus = createEventBus()
    const transport = new PollingTransport()
    const manager = createFleetManager({
        remi: fakeRemi(),
        transportFor: () => transport,
        driverFor: () => driver,
        fleet: { supportsCommandInterrupt: true },
        env: { transport: 'http' },
        bus,
        seq: createSeq(createStateStore(join(dir, '.efk-state.json'))),
        now: clock.now,
        tickMs: 0,
    })
    const started = await manager.start()
    assert.equal(started.ok, true)
    managers.push(manager)
    const app = createPartnerApp({
        token: TOKEN,
        bots: () => manager.bots(),
        serve: () => manager.serve(),
        capabilities: () => manager.capabilities(),
        onCommand: (botId, command) => {
            if (!transport.handler) throw new Error('the manager registered no command handler')
            return transport.handler(botId, command)
        },
        bus,
    })
    const auth = { authorization: `Bearer ${TOKEN}` }
    return { app, auth, driver, manager, clock, bus }
}
const cmd = (id: string) => JSON.stringify({ id, type: 'navigate_to', params: { lat: 1, lng: 2 }, issued_at: new Date().toISOString() })

describe('partner HTTP surface', () => {
    it('401 without the right bearer', async () => {
        const { app } = await harness()
        assert.equal((await app.request('/bots')).status, 401)
        assert.equal((await app.request('/bots', { headers: { authorization: 'Bearer nope' } })).status, 401)
    })
    it('401 says the same thing whether the token is missing or wrong, and never echoes it', async () => {
        const { app } = await harness()
        const absent = await (await app.request('/bots')).text()
        const wrong = await (await app.request('/bots', { headers: { authorization: `Bearer ${'b'.repeat(32)}` } })).text()
        assert.equal(absent, wrong, 'telling them apart tells a caller probing the surface which half of the guess was right')
        assert.doesNotMatch(absent, /aaaa/, 'the configured token never appears in a response')
        // The comparison is constant time over SHA-256 digests, so a header of any length takes the
        // same path: a length check in front of it would leak the token's length instead.
        const shorter = await (await app.request('/bots', { headers: { authorization: 'Bearer b' } })).text()
        const longer = await (await app.request('/bots', { headers: { authorization: `Bearer ${'b'.repeat(200)}` } })).text()
        assert.equal(shorter, wrong)
        assert.equal(longer, wrong)
    })
    it('GET /bots returns every bot as a complete BotState, without seq, and reports it served', async () => {
        const { app, auth, bus } = await harness()
        const served: string[] = []
        bus.on('state.served', (e) => served.push(e.botId))
        const res = await app.request('/bots', { headers: auth })
        assert.equal(res.status, 200)
        const body = (await res.json()) as { bots: Array<{ bot_id: string; seq?: number }> }
        assert.equal(body.bots.length, 1)
        assert.equal(body.bots[0]?.bot_id, 'ACME-0001')
        assert.equal(body.bots[0]?.seq, undefined, 'polling does not consume the counter')
        assert.deepEqual(served, ['ACME-0001'])
    })
    it('GET /bots still lists a bot that lost its position, using its last valid state', async () => {
        const { app, auth, driver } = await harness()
        await app.request('/bots', { headers: auth }) // one good assembly first
        driver.snap = { ...driver.snap, position: null }
        const res = await app.request('/bots', { headers: auth })
        const body = (await res.json()) as { bots: Array<{ bot_id: string }> }
        assert.deepEqual(
            body.bots.map((b) => b.bot_id),
            ['ACME-0001'],
            'every bot on every call: a shorter list reads as "that bot is gone"',
        )
    })
    it('GET /bots omits — and names in the log — only a bot that has never had a position', async () => {
        const { app, auth, driver, bus } = await harness()
        const warnings: string[] = []
        bus.on('log', (l) => warnings.push(l.message))
        driver.snap = { ...driver.snap, position: null }
        const res = await app.request('/bots', { headers: auth })
        assert.deepEqual((await res.json()) as unknown, { bots: [] })
        assert.match(warnings.join('\n'), /never had a position: ACME-0001/)
    })
    it('POST command → 202 with the CommandStatus, never 200; the same id again replays the same answer', async () => {
        const { app, auth } = await harness()
        const post = (body: string) =>
            app.request('/bots/ACME-0001/commands', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body })
        const first = await post(cmd('J/p'))
        assert.equal(first.status, 202)
        const body = (await first.json()) as { id: string; state: string; accepted_at: string }
        assert.equal(body.state, 'accepted')
        const again = await post(cmd('J/p'))
        assert.equal(again.status, 202)
        assert.deepEqual((await again.json()) as unknown, body, 'a resend gets the recorded status, unchanged')
    })
    it('a resend of a REJECTED command replays the rejection, not a 202', async () => {
        const { app, auth, driver } = await harness()
        driver.accept = { kind: 'rejected', code: 'DESTINATION_UNREACHABLE', message: 'far', correctionDistanceM: 340 }
        const post = (body: string) =>
            app.request('/bots/ACME-0001/commands', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body })
        const first = await post(cmd('J/far'))
        assert.equal(first.status, 422)
        const again = await post(cmd('J/far'))
        // A 202 here would tell remi "accepted" about work this fleet refused, and remi resends
        // exactly in the cases where the second answer is the one it acts on.
        assert.equal(again.status, 422)
        assert.deepEqual((await again.json()) as unknown, await first.json())
    })
    it('404 BOT_NOT_FOUND, 400 on an invalid body, 409 COMMAND_EXPIRED, 422 UNSUPPORTED_COMMAND, 422 DESTINATION_UNREACHABLE with distance, 503 DRIVER_ERROR', async () => {
        const { app, auth, driver } = await harness()
        const post = (path: string, body: string) =>
            app.request(path, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body })
        assert.equal((await post('/bots/ACME-9999/commands', cmd('J/x'))).status, 404)
        assert.equal((await post('/bots/ACME-0001/commands', '{"id":"J/bad"}')).status, 400)
        const expired = await post(
            '/bots/ACME-0001/commands',
            JSON.stringify({
                id: 'J/e',
                type: 'navigate_to',
                params: { lat: 1, lng: 2 },
                issued_at: new Date().toISOString(),
                expires_at: '2020-01-01T00:00:00Z',
            }),
        )
        assert.equal(expired.status, 409)
        // The machine code is in `code`; `title` is the human phrase for the status.
        const expiredBody = (await expired.json()) as { title: string; code: string }
        assert.equal(expiredBody.code, 'COMMAND_EXPIRED')
        assert.equal(expiredBody.title, 'Conflict')
        driver.caps = { has_door: false, supported_commands: ['navigate_to', 'cancel_navigation'] }
        const unsupported = await post(
            '/bots/ACME-0001/commands',
            JSON.stringify({ id: 'J/d', type: 'set_door', params: { state: 'open' }, issued_at: new Date().toISOString() }),
        )
        assert.equal(unsupported.status, 422)
        assert.equal(((await unsupported.json()) as { code: string }).code, 'UNSUPPORTED_COMMAND')
        driver.accept = { kind: 'rejected', code: 'DESTINATION_UNREACHABLE', message: 'far', correctionDistanceM: 340 }
        const far = await post('/bots/ACME-0001/commands', cmd('J/far'))
        assert.equal(far.status, 422)
        assert.equal(((await far.json()) as { correction_distance_m: number }).correction_distance_m, 340)
        driver.throwOnNext = true
        const boom = await post('/bots/ACME-0001/commands', cmd('J/boom'))
        assert.equal(boom.status, 503)
        assert.equal(((await boom.json()) as { code: string }).code, 'DRIVER_ERROR')
    })
    it('GET /bots/:id/commands/* reads an id that contains a slash, which every real one does', async () => {
        const { app, auth } = await harness()
        const realId = 'GW-5867/pickup'
        await app.request('/bots/ACME-0001/commands', {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ id: realId, type: 'navigate_to', params: { lat: 1, lng: 2 }, issued_at: new Date().toISOString() }),
        })
        // Both forms reach the same command: remi may or may not percent-encode the separator.
        const encoded = await app.request(`/bots/ACME-0001/commands/${encodeURIComponent(realId)}`, { headers: auth })
        assert.equal(encoded.status, 200)
        assert.equal(((await encoded.json()) as { id: string }).id, realId)
        const raw = await app.request(`/bots/ACME-0001/commands/${realId}`, { headers: auth })
        assert.equal(raw.status, 200)
        assert.equal(((await raw.json()) as { id: string }).id, realId)
        assert.equal((await app.request('/bots/ACME-0001/commands/nope', { headers: auth })).status, 404)
    })
    it('GET /capabilities and POST /destinations/validate (200, 400 INVALID_COORDINATE)', async () => {
        const { app, auth } = await harness()
        const caps = await app.request('/capabilities', { headers: auth })
        assert.equal(caps.status, 200)
        const ok = await app.request('/destinations/validate', {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ lat: 1, lng: 2 }),
        })
        assert.equal(ok.status, 200)
        assert.deepEqual(await ok.json(), { reachable: true, corrected_position: { lat: 1, lng: 2 }, correction_distance_m: 0 })
        const bad = await app.request('/destinations/validate', {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ lat: 91, lng: 2 }),
        })
        assert.equal(bad.status, 400)
        assert.equal(((await bad.json()) as { code: string }).code, 'INVALID_COORDINATE')
    })
    it('polling DRAINS the ledger: the next outcome only reaches the slot because the served one was acknowledged', async () => {
        const { app, auth, driver } = await harness()
        driver.accept = { kind: 'rejected', code: 'BOT_BUSY', message: 'busy' }
        const post = (body: string) =>
            app.request('/bots/ACME-0001/commands', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body })
        await post(cmd('J/one'))
        await post(cmd('J/two'))
        const current = async () => {
            const body = (await (await app.request('/bots', { headers: auth })).json()) as {
                bots: Array<{ current_command: { id: string } }>
            }
            return body.bots[0]?.current_command?.id
        }
        // Nothing is ever pushed in this mode (the transport refuses every publish), so the queue of
        // unpublished outcomes empties ONLY because the poll acknowledged what it served. Building
        // the answer from the runtimes instead of `serve()` would hand out `J/one` for ever and remi
        // would never learn how `J/two` ended.
        assert.equal(await current(), 'J/one')
        assert.equal(await current(), 'J/two')
    })
    it('serves the stale fallback without acknowledging it, so an outcome remi has not seen survives', async () => {
        const { app, auth, driver, manager } = await harness()
        driver.accept = { kind: 'rejected', code: 'BOT_BUSY', message: 'busy' }
        const post = (body: string) =>
            app.request('/bots/ACME-0001/commands', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body })
        await post(cmd('J/one'))
        // A tick the transport REFUSED: it refreshed the fallback snapshot — which now carries the
        // rejection — without delivering anything, so that outcome is still owed to remi.
        await manager.tickOnce()
        await post(cmd('J/two'))
        driver.snap = { ...driver.snap, position: null }
        const stale = (await (await app.request('/bots', { headers: auth })).json()) as {
            bots: Array<{ current_command: { id: string } | null }>
        }
        assert.equal(stale.bots[0]?.current_command?.id, 'J/one', 'the fallback is served, staleness and all')
        driver.snap = { ...driver.snap, position: { lat: 33.97, lng: -118.41 } }
        const fresh = (await (await app.request('/bots', { headers: auth })).json()) as {
            bots: Array<{ current_command: { id: string } | null }>
        }
        // Acknowledging the fallback would have popped this outcome for a state that never left the
        // process, and remi would never learn how the command it issued ended.
        assert.equal(fresh.bots[0]?.current_command?.id, 'J/one')
    })
    it('never lets the ledger-internal REPLACED code out through any response', async () => {
        const { app, auth } = await harness()
        const post = (body: string) =>
            app.request('/bots/ACME-0001/commands', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body })
        await post(cmd('J/n1'))
        await post(cmd('J/n2')) // interrupt: J/n1 is now `failed` with the internal code REPLACED
        const read = await app.request('/bots/ACME-0001/commands/J/n1', { headers: auth })
        assert.equal(read.status, 200, 'the id is known, so a 404 would read as "never received" and invite a resend')
        const readBody = await read.text()
        assert.doesNotMatch(readBody, /REPLACED/i, 'the contract has no such outcome and nothing below this layer would stop it')
        const status = JSON.parse(readBody) as CommandStatus
        assert.equal(status.state, 'failed')
        assert.equal(status.error?.code, 'SUPERSEDED')
        const resend = await post(cmd('J/n1'))
        assert.equal(resend.status, 202)
        assert.doesNotMatch(await resend.text(), /REPLACED/i, 'the duplicate path replays the ledger status and must sanitise it too')
        assert.doesNotMatch(await (await app.request('/bots', { headers: auth })).text(), /REPLACED/i)
    })
})
