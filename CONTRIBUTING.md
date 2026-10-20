# Contributing

- Open an issue before a large change; small fixes can go straight to a PR.
- `pnpm check && pnpm typecheck && pnpm test` must pass. Tests use `node --test`; randomness and clocks are injected, never global.
- Never paste a `.env`, an API key, a broker password or a bearer token into an issue, a PR or a log excerpt. `efk check --json` output is safe: it contains no secrets.
- Read configuration through `loadEnv` (`src/cli/env.ts`), never with `Number(process.env.…)` or a fallback of your own: the schema is what refuses a bad value, and a second reader with a default fails silently (a missing latitude becomes a fleet placed somewhere else). Need a derived value, like the sandbox origin? Export it from `env.ts` (`sandboxOrigin`).
- Contract changes come from remi's documentation page, not from this repo: if a sample no longer validates, the fix is `pnpm sync-samples` against the new page plus a version bump, not a schema edit by hand.
- Commit messages: Conventional Commits, in English.
