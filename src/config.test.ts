import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { defineConfig, loadConfig } from './config'
import { FakeDriver } from './core/fakes'

const REPO_ROOT = join(import.meta.dirname, '..')

describe('efk.config.ts', () => {
    it('defineConfig is a type helper: it returns exactly what it was given', () => {
        const driver = (botId: string) => new FakeDriver(botId)
        const config = defineConfig({ driver, fleet: { supportsCommandInterrupt: false } })
        assert.equal(config.driver, driver)
        assert.equal(config.fleet.supportsCommandInterrupt, false)
    })
    /**
     * The repo ships its own `efk.config.ts` — the file a partner edits to swap the driver — and it
     * is the one the CLI loads when nobody passes `--config`. If it stopped loading, `efk check` C9
     * and `efk start` would both fail on a fresh clone, so the shipped file is loaded for real here.
     */
    it('loads the config this repo ships, with a driver factory and the fleet flag', async () => {
        const loaded = await loadConfig(join(REPO_ROOT, 'efk.config.ts'))
        assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.error)
        if (!loaded.ok) return
        assert.equal(typeof loaded.config.driver, 'function')
        assert.equal(typeof loaded.config.fleet.supportsCommandInterrupt, 'boolean')
        const driver = loaded.config.driver('ACME-0001', { origin: { lat: 33.97, lng: -118.41 } })
        assert.equal(driver.botId, 'ACME-0001')
        assert.equal(driver.driverVersion, 1)
        // The bundled scenarios are written for the Acme cast, so the audit has something to say.
        assert.deepEqual(driver.capabilities().supportedCommands.includes('navigate_to'), true)
    })
    it('a missing file is a reported error, never a throw', async () => {
        const loaded = await loadConfig(join(REPO_ROOT, 'no-such-file.config.ts'))
        assert.equal(loaded.ok, false)
        assert.match(loaded.ok ? '' : loaded.error, /no-such-file\.config\.ts|Cannot find module/)
    })
    it('a module that does not default-export a config says what the file must contain', async () => {
        // `src/config.ts` is a real, loadable module with no default export: the exact shape of a
        // partner who deleted the `export default` or exported the object by name.
        const loaded = await loadConfig(join(import.meta.dirname, 'config.ts'))
        assert.equal(loaded.ok, false)
        assert.match(loaded.ok ? '' : loaded.error, /must default-export defineConfig\(\{ driver, fleet \}\)/)
    })
})
