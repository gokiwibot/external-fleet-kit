/**
 * A scenario is the desired behaviour of the simulated fleet: a `default` per-bot block, per-bot
 * `overrides`, and where the fleet appears. Every field has a default (`{}` is the default
 * scenario), as in bot-sim's `spec.ts`, and `.prefault({})` is the zod 4 way to default a nested
 * object whose fields have defaults. The fault catalogue IS this schema: every failure the
 * simulator reproduces is a field here (design §6.2).
 *
 * TWO SHAPES PER BLOCK, and the reason matters. `botScenarioSchema` is the EFFECTIVE scenario: every
 * field present, defaults applied. `botScenarioOverrideSchema` is what a JSON file may write: the
 * same fields, same ranges, all optional, NO defaults. Merging has to happen between raw documents
 * and the defaults applied once at the end — a `botScenarioSchema.partial()` would fill the override
 * with defaults first and then those defaults would overwrite the siblings the `default` block set,
 * so `{ default: { battery: { startPct: 90 } }, overrides: { X: { door: {...} } } }` would silently
 * put bot X back at 100 %. Every object is `z.strictObject`, at all three levels: a misspelled knob
 * is the single most likely mistake in a hand-written scenario and it must fail with a path, not be
 * dropped in silence.
 */
import { z } from 'zod'

/** Field constraints, declared once and reused by both shapes so the ranges cannot drift apart. */
const noiseFields = {
    /** GPS wander perpendicular to the segment, metres. A smoothed random walk, not per-tick jitter. */
    lateralM: z.number().min(0).max(50),
    /** Cruise multiplied by a slowly varying 1 ± this. */
    speedJitter: z.number().min(0).max(0.9),
    /** Unplanned dwells per kilometre, Poisson along the route. */
    stopRatePerKm: z.number().min(0).max(100),
    /** How long each unplanned dwell lasts: [min, max] seconds. */
    stopSecs: z.tuple([z.number().min(0), z.number().min(0)]),
    headingNoiseDeg: z.number().min(0).max(180),
}
const motionFields = {
    speedMps: z.number().min(0).max(30),
    /** normal: arrive and confirm. never: park 1 m short for ever. stall: give up at 60 %. */
    arrive: z.enum(['normal', 'never', 'stall']),
    /** false: navigate_to is executed but never reflected in current_command (the lost echo). */
    ackGoals: z.boolean(),
}
const doorFields = {
    hasDoor: z.boolean(),
    /** full: 2 s through opening/closing. boolean: only opened/closed, no transients. stalled / ignore: faults. */
    mode: z.enum(['full', 'boolean', 'stalled', 'ignore']),
    transitionMs: z.number().min(0).max(60_000),
}
const batteryFields = {
    startPct: z.number().int().min(0).max(100),
    drainPctPerKm: z.number().min(0).max(100),
    rechargePctPerMin: z.number().min(0).max(100),
    /** available: false below this. 0 = off. */
    unavailableBelowPct: z.number().int().min(0).max(100),
}
const linkFields = {
    mode: z.enum(['online', 'offline', 'flapping']),
    flapPeriodMs: z.number().min(1_000).max(600_000),
}
const destinationsFields = {
    /** 0 = no correction. 0.0002 ≈ 22 m: destinations snap to the nearest grid node. */
    snapGridDeg: z.number().min(0).max(0.01),
    /** 0 = everything reachable. Measured from fleet.origin, never from the bot. */
    unreachableBeyondM: z.number().min(0),
}

export const noiseSchema = z.strictObject({
    lateralM: noiseFields.lateralM.default(0.8),
    speedJitter: noiseFields.speedJitter.default(0.15),
    stopRatePerKm: noiseFields.stopRatePerKm.default(2),
    stopSecs: noiseFields.stopSecs.default([3, 15]),
    headingNoiseDeg: noiseFields.headingNoiseDeg.default(3),
})
export type Noise = z.output<typeof noiseSchema>

export const botScenarioSchema = z.strictObject({
    motion: z
        .strictObject({
            speedMps: motionFields.speedMps.default(1.5),
            arrive: motionFields.arrive.default('normal'),
            ackGoals: motionFields.ackGoals.default(true),
            noise: noiseSchema.prefault({}),
        })
        .prefault({}),
    door: z
        .strictObject({
            hasDoor: doorFields.hasDoor.default(true),
            mode: doorFields.mode.default('full'),
            transitionMs: doorFields.transitionMs.default(2_000),
        })
        .prefault({}),
    battery: z
        .strictObject({
            startPct: batteryFields.startPct.default(100),
            drainPctPerKm: batteryFields.drainPctPerKm.default(2),
            rechargePctPerMin: batteryFields.rechargePctPerMin.default(0),
            unavailableBelowPct: batteryFields.unavailableBelowPct.default(0),
        })
        .prefault({}),
    link: z
        .strictObject({
            mode: linkFields.mode.default('online'),
            flapPeriodMs: linkFields.flapPeriodMs.default(20_000),
        })
        .prefault({}),
    destinations: z
        .strictObject({
            snapGridDeg: destinationsFields.snapGridDeg.default(0),
            unreachableBeyondM: destinationsFields.unreachableBeyondM.default(0),
        })
        .prefault({}),
    available: z.boolean().default(true),
})
export type BotScenario = z.output<typeof botScenarioSchema>

/** What a JSON file may write: same fields, same ranges, all optional, no defaults applied. */
export const botScenarioOverrideSchema = z
    .strictObject({
        motion: z.strictObject({ ...motionFields, noise: z.strictObject(noiseFields).partial() }).partial(),
        door: z.strictObject(doorFields).partial(),
        battery: z.strictObject(batteryFields).partial(),
        link: z.strictObject(linkFields).partial(),
        destinations: z.strictObject(destinationsFields).partial(),
        available: z.boolean(),
    })
    .partial()
export type BotScenarioOverride = z.output<typeof botScenarioOverrideSchema>

export const scenarioSchema = z.strictObject({
    v: z.literal(1).default(1),
    fleet: z
        .strictObject({
            /**
             * Where the bots appear and where destinations.* are measured from. remi NEVER sends positions
             * to the partner, so null means "use SANDBOX_CENTER_LAT/LNG from the .env"; if those are
             * missing too, efk start refuses to run.
             */
            origin: z
                .strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
                .nullable()
                .default(null),
            scatterRadiusM: z.number().min(0).max(500).default(40),
        })
        .prefault({}),
    default: botScenarioOverrideSchema.default({}),
    overrides: z.record(z.string(), botScenarioOverrideSchema).default({}),
})
export type Scenario = z.output<typeof scenarioSchema>

export function parseScenario(raw: unknown): Scenario {
    return scenarioSchema.parse(raw ?? {})
}

type JsonObject = Record<string, unknown>
const isPlainObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Deep merge of two scenario documents: `override` wins leaf by leaf, and a key the override does
 * not mention keeps the base's value at ANY depth. Arrays (`stopSecs`) are replaced whole, never
 * merged element by element — half of one tuple and half of another is nobody's intent. Pure, so the
 * merge can be tested on its own, which is the only way to be sure the sibling-eating bug is gone.
 */
export function mergeScenario(base: JsonObject, override: JsonObject): JsonObject {
    const out: JsonObject = { ...base }
    for (const [key, value] of Object.entries(override)) {
        if (value === undefined) continue
        const existing = out[key]
        out[key] = isPlainObject(existing) && isPlainObject(value) ? mergeScenario(existing, value) : value
    }
    return out
}

/** The effective per-bot scenario: the raw override deep-merged over the raw default, parsed once. */
export function botScenarioFor(scenario: Scenario, botId: string): BotScenario {
    const merged = mergeScenario(scenario.default as JsonObject, (scenario.overrides[botId] ?? {}) as JsonObject)
    return botScenarioSchema.parse(merged)
}

/** Override keys that name a bot the roster does not have: a typo, or a scenario written for another fleet. */
export function overrideIdsNotIn(scenario: Scenario, roster: string[]): string[] {
    const known = new Set(roster)
    return Object.keys(scenario.overrides).filter((id) => !known.has(id))
}
