/**
 * efk.config.ts: the one file a partner edits to swap the driver. Loaded through tsx (the CLI already
 * runs under it), so a plain `import()` of an absolute path works. `import()` is otherwise banned in
 * this repo; this is the single sanctioned use, because the file is user-authored: its path is only
 * known at runtime, so a static import cannot reach it. Do not add a second one.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DriverFactory } from './driver/robot-driver'

/**
 * Re-exported, NOT re-declared: `DriverFactory` has exactly one declaration, in `robot-driver.ts`,
 * because the simulated driver and this loader both need it and a second
 * copy is how the two drift apart. A partner's `efk.config.ts` can import the name from here.
 */
export type { DriverFactory }

export type KitConfig = {
    driver: DriverFactory
    fleet: { supportsCommandInterrupt: boolean }
}

export function defineConfig(config: KitConfig): KitConfig {
    return config
}

export async function loadConfig(path = 'efk.config.ts'): Promise<{ ok: true; config: KitConfig } | { ok: false; error: string }> {
    try {
        const mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: KitConfig }
        if (!mod.default?.driver || typeof mod.default.fleet?.supportsCommandInterrupt !== 'boolean') {
            return { ok: false, error: `${path} must default-export defineConfig({ driver, fleet })` }
        }
        return { ok: true, config: mod.default }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
}
