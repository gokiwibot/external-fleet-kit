import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type CommandTerminal, type DriverContext, defaultValidateDestination, type Position } from './index'

/**
 * `src/index.ts` is the package's public entry point: a partner writing their own driver in their
 * own file (not next to `robot-driver.ts`) can only name these types by importing them from here.
 *
 * This pins that surface. Every name below is imported from `./index`, never from
 * `./driver/robot-driver` directly — a test that reached past the entry point to the internal
 * module would still pass after the export was deleted from `index.ts`, which is exactly the gap
 * this test exists to close.
 */
describe('public entry point: driver types a partner needs to name', () => {
    it('exports Position and it shapes a real coordinate', () => {
        const origin: Position = { lat: 33.97, lng: -118.41 }
        assert.equal(origin.lat, 33.97)
        assert.equal(origin.lng, -118.41)
    })

    it('exports DriverContext and it types the parameter of start(ctx)', () => {
        const seen: Array<{ message: string; data?: Record<string, unknown> }> = []
        const ctx: DriverContext = {
            now: () => 1700000000000,
            log: (message, data) => {
                seen.push({ message, data })
            },
        }
        ctx.log('hello', { botId: 'ACME-0001' })
        assert.equal(typeof ctx.now(), 'number')
        assert.deepEqual(seen, [{ message: 'hello', data: { botId: 'ACME-0001' } }])
    })

    it('exports CommandTerminal and it names the two terminal command states', () => {
        const terminals: CommandTerminal[] = ['succeeded', 'failed']
        assert.deepEqual(terminals, ['succeeded', 'failed'])
    })

    it('exports defaultValidateDestination and it returns the point unchanged', async () => {
        const position: Position = { lat: 1, lng: 2 }
        const result = await defaultValidateDestination(position)
        assert.deepEqual(result, { reachable: true, corrected_position: position, correction_distance_m: 0 })
    })
})
