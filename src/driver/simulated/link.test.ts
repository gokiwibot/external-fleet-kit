import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLink } from './link'
import { botScenarioSchema } from './scenario'

describe('link', () => {
    it('online is always connected, offline never', () => {
        assert.equal(createLink(botScenarioSchema.parse({ link: { mode: 'online' } }).link, 0).shouldBeConnected(99_999), true)
        assert.equal(createLink(botScenarioSchema.parse({ link: { mode: 'offline' } }).link, 0).shouldBeConnected(99_999), false)
    })
    it('flapping alternates every half period, starting connected', () => {
        const link = createLink(botScenarioSchema.parse({ link: { mode: 'flapping', flapPeriodMs: 20_000 } }).link, 0)
        assert.equal(link.shouldBeConnected(0), true)
        assert.equal(link.shouldBeConnected(9_999), true)
        assert.equal(link.shouldBeConnected(10_000), false)
        assert.equal(link.shouldBeConnected(19_999), false)
        assert.equal(link.shouldBeConnected(20_000), true)
    })
})
