/**
 * `.efk-state.json`: the one thing the kit persists, and why (design §9.2): the last `seq` per bot,
 * so a restart stays monotonic against remi's `seq` guard. Written atomically (tmp + rename) so a
 * crash mid-write leaves the previous file, never a truncated one.
 *
 * A malformed or empty file reads as empty — a fresh start is the only thing left to do with content
 * nobody can parse — but that is NOT cheap and the kit must not pretend it is: remi discards any
 * state whose `seq` is below the last one it stored, so a bot a week into a run at 4 Hz sits around
 * `seq` 2.4M and a reset to zero means remi silently rejects that bot for days. The discard is
 * therefore reported through `onDiscard` so an operator can be told, rather than swallowed.
 *
 * An IO error is a different thing entirely and is never treated as "no state": a file we cannot
 * read (EACCES, EISDIR, …) is a file whose counters are intact on disk, and resetting them because
 * of a permissions mistake would be the expensive mistake above, self-inflicted. Only ENOENT — the
 * ordinary first run — means empty. Everything else propagates.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

export const kitStateSchema = z.object({
    v: z.literal(1).default(1),
    seq: z.record(z.string(), z.number().int().min(0)).default({}),
})
export type KitState = z.output<typeof kitStateSchema>

/** `onDiscard` is the seam for reporting a reset; wiring it to the event bus belongs to the caller. */
export type StateStoreDeps = { onDiscard?: (reason: string) => void }

export interface StateStore {
    read(): KitState
    write(patch: Partial<KitState>): void
}

export function createStateStore(path: string, deps: StateStoreDeps = {}): StateStore {
    const empty = (): KitState => kitStateSchema.parse({})
    const read = (): KitState => {
        let raw: string
        try {
            raw = readFileSync(path, 'utf8')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
            throw error
        }
        try {
            return kitStateSchema.parse(JSON.parse(raw))
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            deps.onDiscard?.(`${path} is not readable kit state, the seq counters restart at 1: ${detail}`)
            return empty()
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
