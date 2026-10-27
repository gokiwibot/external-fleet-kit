# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer. Each version states the contract version and the `data.ts` commit its samples are frozen against.

## [Unreleased]

### Changed
- `efk check` C9 fails a driver whose `supportedCommands` lacks `navigate_to` or `cancel_navigation`. remi requires both and rejects a capabilities document whose default lacks them (`400 CAPABILITIES_MISSING_REQUIRED_COMMANDS`); until now the preflight passed such a fleet and `efk start` only logged the refusal.
- The opt-in MQTT wire test accepts only a broker on this machine (`localhost`, `127.0.0.1`, `[::1]`), off port 1883. It used to refuse one production host by name.
- CI pins its actions by commit SHA and runs with a read-only token.

### Documentation
- `out_of_service` does not make a bot unavailable: remi keeps assigning it, alerts its operators while it carries a job, and clears the alert when the field goes back to `false`. The README and the `botState` schema still described the old behaviour (parked `off_duty`, one-way).
- Comments say what the code does, without references to internal planning documents.
- `SECURITY.md` (private vulnerability reporting), issue forms that point contract questions and integration support at the docs and the onboarding contact, `CODEOWNERS`, and a README section on versioning and support.

## [0.1.0] - 2026-10-27

Contract `2026-09`, samples frozen from kiwi-platforms `54df6f670` (`data.ts` sha256 `3dea23d7…`). The first tagged version: the kit as first written (*Initial kit*, at the end of this entry) plus what its first fork taught it.

Absorbed from the first fork of the kit that drives real robots. Only what any partner needs; that fork's own driver stays in the fork.

### Added
- `Dockerfile`, `docker/entrypoint.sh` and `.dockerignore`; README section *Running it in a container*.
- `EFK_STATE_DIR` moves `.efk.lock` and `.efk-state.json` onto a volume. Declared in the `.env` schema.
- `GET /healthz` on the HTTP surface, before the bearer check, for probes that send no headers. It says the process is listening, nothing about the fleet.

- **The roster is re-read every 15 s** (`ROSTER_REFRESH_MS`) instead of being frozen at `start()`. Only the bots that changed are rebuilt; a refresh never parks a fleet that is driving, never rebuilds a bot running a command, and skips its pass if remi is unreachable. `Transport.setBots` tells the HTTP surface and the MQTT connections about the change.
- **`fleet_serial` and `requires_fleet_serial`** (remi's mapping from its bot id to the partner's own id). `DriverFactory` receives `env.fleetSerial`; `efk start` and `efk check` share one `selectRoster()` so the preflight judges the same bots the start drives.
- **Idle start.** An empty roster, an unmapped bot on a fleet that requires `fleet_serial`, or a factory whose new optional `unavailable()` answers a sentence, bring the fleet up with no bots and say once why, instead of refusing to start or throwing once per robot.
- `sandboxOrigin(env)` in `src/cli/env.ts`: the one place that turns `SANDBOX_CENTER_*` into a position, used by `efk start` and `efk check`. CONTRIBUTING now forbids reading configuration with `Number(process.env.…)`.
- `DriverSnapshot.azimuth` and `DriverSnapshot.outOfService`, sent as the contract's optional `position.azimuth` and `out_of_service`. The vendored `botStateSchema` is strict, so before this a partner on the kit could not send either field even though the page documents both.

### Changed
- Samples re-frozen from the contract page at kiwi-platforms `54df6f670`, the commit that also records their hash in `KIT_SYNC.json`. They bring `fleet_serial` and `console_url` on the bot samples, the real command id shapes (`door/open/<ms>`, `cancel/<ms>`), `azimuth` on the position sample, and the video endpoint's response. The parity schemas accept `fleet_serial` and `console_url` on a registered bot and know the new sample.
- `SANDBOX_*` are optional; an empty value reads as absent, not as `0`. `efk order` refuses without `SANDBOX_LOCATION_ID`, the simulated driver throws without an origin, C3 compares locations only when a sandbox is set, and C9 skips while the driver is unavailable.
- **An idle fleet no longer sends an empty capabilities document** (`has_door: false`, no commands). remi does not stop dispatching on it, but it drops every `set_door` and turns `manual_close_door` on for every bot, one-way: the flag stays after a good document arrives and is cleared by hand, bot by bot. An unchanged document is not re-sent either.

### Documentation
- The kit is single-instance (`replicas: 1`, `Recreate`, `ReadWriteOncePod`), and the README now says so.
- The template and `DriverAccept` said "anything that is not a contract code must be a throw". That taught the bug the fork had to fix: a deterministic partner error thrown burns remi's 3 resends on the same answer and the delivery dies with no outcome. Now: throw only what a resend can fix, reject the rest.
- `available` is the partner's own verdict, one to one; a cached position must not be repeated as current; the partner's idempotency may differ per endpoint; an unconfirmed action is read from telemetry; log the partner's mission id next to remi's command id.
- `validateDestination`: remi does not call `POST /destinations/validate` in the current release. It stays optional, not removed.

### Initial kit
- `FleetManager`, `BotRuntime`, `CommandLedger`, `Cadence`, persisted `seq` and single-instance lock.
- `RobotDriver` v1 with `validateDestination`, and a commented partner template.
- `SimulatedRobotDriver`: straight-line motion with noise, four door modes, battery drain, link modes, destination correction; seven scenarios.
- MQTT transport (one connection per bot, retained state and capabilities, backoff) and HTTP transport (five partner endpoints, optional push).
- `efk check` (C1–C9), `efk start` (TUI, `--web`, `--headless`, `--check`, `--demo`), `efk order create|watch`, `efk scenarios list`, `efk --version`.
- Vendored contract: strict schemas for what the kit emits, loose for what remi returns, 31 frozen samples and `SOURCE.json`.
