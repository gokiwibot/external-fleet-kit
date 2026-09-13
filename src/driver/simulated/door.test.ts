import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDoor } from './door'
import { botScenarioSchema } from './scenario'

const door = (mode: 'full' | 'boolean' | 'stalled' | 'ignore', hasDoor = true) =>
    botScenarioSchema.parse({ door: { mode, hasDoor, transitionMs: 2_000 } }).door

describe('door', () => {
    it('full: closed → opening → opened over the transition, and back', () => {
        let now = 0
        const d = createDoor(door('full'), () => now)
        assert.equal(d.reported(), 'closed')
        d.command('open')
        d.tick()
        assert.equal(d.reported(), 'opening')
        now = 2_000
        assert.equal(d.tick(), true)
        assert.equal(d.reported(), 'opened')
        d.command('closed')
        d.tick()
        assert.equal(d.reported(), 'closing')
        now = 4_000
        d.tick()
        assert.equal(d.reported(), 'closed')
    })
    it('boolean: only ever reports opened/closed; the flip happens when the transition ends', () => {
        let now = 0
        const d = createDoor(door('boolean'), () => now)
        d.command('open')
        d.tick()
        assert.equal(d.reported(), 'closed', 'still closed while the lid physically moves')
        now = 1_000
        d.tick()
        assert.equal(d.reported(), 'closed')
        now = 2_000
        assert.equal(d.tick(), true)
        assert.equal(d.reported(), 'opened')
    })
    it('stalled: accepts and lands on stalled for ever', () => {
        let now = 0
        const d = createDoor(door('stalled'), () => now)
        d.command('open')
        d.tick()
        now = 5_000
        d.tick()
        assert.equal(d.reported(), 'stalled')
    })
    it('ignore: nothing changes', () => {
        let now = 0
        const d = createDoor(door('ignore'), () => now)
        d.command('open')
        now = 5_000
        assert.equal(d.tick(), false)
        assert.equal(d.reported(), 'closed')
    })
    it('no door: unsupported, always', () => {
        const d = createDoor(door('full', false), () => 0)
        d.command('open')
        d.tick()
        assert.equal(d.reported(), 'unsupported')
    })
    it('open when already opened is a no-op, and command() says so', () => {
        let now = 0
        const d = createDoor(door('full'), () => now)
        assert.equal(d.command('open'), true)
        now = 2_000
        d.tick()
        assert.equal(d.command('open'), false, 'nothing to wait for: the caller resolves the command now')
        assert.equal(d.tick(), false)
        assert.equal(d.reported(), 'opened')
    })
    it('closed on an already closed door is the same no-op — the commonest command remi sends', () => {
        const d = createDoor(door('full'), () => 0)
        assert.equal(d.reported(), 'closed')
        assert.equal(d.command('closed'), false)
        assert.equal(d.command('closed'), false, 'in boolean mode too, and with no door at all')
        assert.equal(createDoor(door('boolean'), () => 0).command('closed'), false)
        assert.equal(createDoor(door('full', false), () => 0).command('open'), false)
        assert.equal(createDoor(door('ignore'), () => 0).command('open'), false)
    })
    it('pending(): true only while the lid is actually moving, even in boolean mode where reported() cannot tell', () => {
        let now = 0
        const d = createDoor(door('boolean'), () => now)
        assert.equal(d.pending(), false, 'nothing commanded yet')
        d.command('open')
        d.tick()
        assert.equal(d.pending(), true, 'reported() still says closed, but the lid is moving')
        now = 1_999
        d.tick()
        assert.equal(d.pending(), true, 'one tick before the transition ends')
        now = 2_000
        d.tick()
        assert.equal(d.pending(), false, 'the transition just ended')
        assert.equal(d.reported(), 'opened')
    })
    it('pending(): a no-op command() never starts one', () => {
        const d = createDoor(door('full'), () => 0)
        assert.equal(d.command('closed'), false)
        assert.equal(d.pending(), false)
    })
})
