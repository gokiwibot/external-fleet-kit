import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BOT_ID_MAX_LENGTH, hasBotIdPrefix, isValidBotId, isValidNamespace } from './ids'

describe('namespace grammar', () => {
    it('accepts [a-z0-9_]+ and nothing else', () => {
        assert.equal(isValidNamespace('acme'), true)
        assert.equal(isValidNamespace('partner_00001234'), true)
        assert.equal(isValidNamespace('acme-robotics'), false, 'hyphen would break the client id parse')
        assert.equal(isValidNamespace('Acme'), false)
        assert.equal(isValidNamespace(''), false)
    })
})

describe('bot id grammar', () => {
    it('accepts the FleetBot grammar over the whole id, 64 chars max', () => {
        assert.equal(isValidBotId('ACME-0142'), true)
        assert.equal(isValidBotId('ACME-a.b_c-9'), true)
        assert.equal(isValidBotId('A'.repeat(BOT_ID_MAX_LENGTH)), true)
        assert.equal(isValidBotId('A'.repeat(BOT_ID_MAX_LENGTH + 1)), false)
        assert.equal(isValidBotId('ACME/0142'), false, '/ is a topic separator')
        assert.equal(isValidBotId('ACME+0142'), false, '+ is a wildcard')
        assert.equal(isValidBotId('ACME#0142'), false, '# is a wildcard')
        assert.equal(isValidBotId('ACME 0142'), false)
        assert.equal(isValidBotId('ACMÉ-0142'), false, 'non-ASCII')
        assert.equal(isValidBotId(''), false)
    })

    it('checks the prefix separately, as the roster service does', () => {
        assert.equal(hasBotIdPrefix('ACME-0142', 'ACME-'), true)
        assert.equal(hasBotIdPrefix('acme-0142', 'ACME-'), false)
        assert.equal(hasBotIdPrefix('ACME-', 'ACME-'), false, 'prefix alone is not an id')
    })
})
