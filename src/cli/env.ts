/**
 * The .env Robot.com sends. The canonical definition is the provisioning spec §3; this schema IS that
 * table, plus two kit-only optionals (HTTP_PUSH, LOG_LEVEL). Required fields depend on the transport.
 */
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { z } from 'zod'

const bool = z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), z.boolean())
const port = z.coerce.number().int().min(1).max(65535)

export const envSchema = z
    .object({
        REMI_API_URL: z.url(),
        REMI_API_KEY: z.string().regex(/^live_sk_[0-9a-f]{48}$/, 'expected live_sk_ followed by 48 hex characters'),
        REMI_TRANSPORT: z.enum(['mqtt', 'http']),
        MQTT_HOST: z.string().min(1).optional(),
        MQTT_PORT: port.default(8883),
        MQTT_USERNAME: z.string().min(1).optional(),
        /**
         * NOT `.min(1)`. The provisioning flow hands over the broker password out of band, so the
         * `.env` a partner receives has this line present and EMPTY — by design. Failing the schema
         * here turned "you still have to paste the broker password" into ".env does not parse", which
         * sends the partner looking for a syntax error that is not there. `efk check` C1 says it
         * properly, with the runbook step.
         */
        MQTT_PASSWORD: z.string().optional(),
        HTTP_TOKEN: z.string().min(32).optional(),
        HTTP_PORT: port.default(4300),
        HTTP_PUBLIC_URL: z.url().optional(),
        HTTP_PUSH: bool.default(false),
        SANDBOX_LOCATION_ID: z.string().min(1),
        SANDBOX_CENTER_LAT: z.coerce.number().min(-90).max(90),
        SANDBOX_CENTER_LNG: z.coerce.number().min(-180).max(180),
        SANDBOX_PICKUP_EXTERNAL_ID: z.string().min(1).default('efk-sandbox-pickup'),
        SANDBOX_DROPOFF_EXTERNAL_ID: z.string().min(1).default('efk-sandbox-dropoff'),
        WEB_PORT: port.default(4310),
        LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        /** Scenario name for the simulated driver; `--scenario` sets it. Declared so it is not an undocumented magic variable. */
        EFK_SCENARIO: z.string().min(1).default('default'),
        /**
         * Where `.efk.lock` and `.efk-state.json` live; the cwd when unset, `/state` in the image. Declared
         * here so it is not an undocumented magic variable, but `start.ts` reads it straight from
         * `process.env` through `statePath`, and that is deliberate: the lock is taken BEFORE the `.env`
         * is loaded, so a second instance is refused even when the file does not parse.
         */
        EFK_STATE_DIR: z.string().min(1).optional(),
    })
    .superRefine((env, ctx) => {
        if (env.REMI_TRANSPORT === 'mqtt') {
            // MQTT_PASSWORD is deliberately absent from this list: empty is a valid state of the file.
            for (const key of ['MQTT_HOST', 'MQTT_USERNAME'] as const) {
                if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when REMI_TRANSPORT=mqtt' })
            }
        } else {
            for (const key of ['HTTP_TOKEN', 'HTTP_PUBLIC_URL'] as const) {
                if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when REMI_TRANSPORT=http' })
            }
            if (env.HTTP_PUBLIC_URL && !env.HTTP_PUBLIC_URL.startsWith('https://')) {
                ctx.addIssue({ code: 'custom', path: ['HTTP_PUBLIC_URL'], message: 'remi only calls https' })
            }
        }
    })
export type Env = z.output<typeof envSchema>

/** Reads `.env` (if present) under process.env, so an exported variable wins over the file. */
export function readEnvFile(path = '.env'): Record<string, string> {
    try {
        return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>
    } catch {
        return {}
    }
}

/**
 * The issue list never carries a VALUE, only the variable name and what was expected — this string
 * is printed by `efk check` C1 and the .env holds an API key, a broker password and a bearer token.
 */
export function loadEnv(
    source: Record<string, string | undefined> = { ...readEnvFile(), ...process.env },
): { ok: true; env: Env } | { ok: false; error: string } {
    const parsed = envSchema.safeParse(source)
    if (parsed.success) return { ok: true, env: parsed.data }
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
}
