/**
 * `.efk-state.json`: the one thing the kit persists, and why (design §9.2): the last `seq` per bot,
 * so a restart stays monotonic against remi's `seq` guard. Written atomically (tmp + rename) so a
 * crash mid-write leaves the previous file, never a truncated one. A corrupt file reads as empty:
 * losing the counters costs a few rejected states, not a crash loop.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

export const kitStateSchema = z.object({
    v: z.literal(1).default(1),
    seq: z.record(z.string(), z.number().int().min(0)).default({}),
})
export type KitState = z.output<typeof kitStateSchema>

export interface StateStore {
    read(): KitState
    write(patch: Partial<KitState>): void
}

export function createStateStore(path: string): StateStore {
    const read = (): KitState => {
        try {
            return kitStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
        } catch {
            return kitStateSchema.parse({})
        }
    }
    return {
        read,
        write(patch) {
            const next = kitStateSchema.parse({ ...read(), ...patch })
            writeFileSync(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`)
            renameSync(`${path}.tmp`, path)
        },
    }
}
