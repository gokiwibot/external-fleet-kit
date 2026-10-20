# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer. Each version states the contract version and the `data.ts` commit its samples are frozen against.

## [Unreleased]

Absorbed from the first fork of the kit that drives real robots. Only what any partner needs; that fork's own driver stays in the fork.

### Added
- `Dockerfile`, `docker/entrypoint.sh` and `.dockerignore`; README section *Running it in a container*.
- `EFK_STATE_DIR` moves `.efk.lock` and `.efk-state.json` onto a volume. Declared in the `.env` schema.
- `GET /healthz` on the HTTP surface, before the bearer check, for probes that send no headers. It says the process is listening, nothing about the fleet.

- `DriverSnapshot.azimuth` and `DriverSnapshot.outOfService`, sent as the contract's optional `position.azimuth` and `out_of_service`. The vendored `botStateSchema` is strict, so until now a partner on the kit could not send either field even though the page documents both. The frozen samples are not re-synced here.

### Documentation
- The kit is single-instance (`replicas: 1`, `Recreate`, `ReadWriteOncePod`), and the README now says so.
- The template and `DriverAccept` said "anything that is not a contract code must be a throw". That taught the bug the fork had to fix: a deterministic partner error thrown burns remi's 3 resends on the same answer and the delivery dies with no outcome. Now: throw only what a resend can fix, reject the rest.
- `available` is the partner's own verdict, one to one; a cached position must not be repeated as current; the partner's idempotency may differ per endpoint; an unconfirmed action is read from telemetry; log the partner's mission id next to remi's command id.
- `validateDestination`: remi does not call `POST /destinations/validate` in the current release. It stays optional, not removed.

## [0.1.0] - unreleased

The date of this entry is set when the `0.1.0` tag is cut.

Contract `2026-09`, `data.ts` `pending-N2`.

### Added
- `FleetManager`, `BotRuntime`, `CommandLedger`, `Cadence`, persisted `seq` and single-instance lock.
- `RobotDriver` v1 with `validateDestination`, and a commented partner template.
- `SimulatedRobotDriver`: straight-line motion with noise, four door modes, battery drain, link modes, destination correction; seven scenarios.
- MQTT transport (one connection per bot, retained state and capabilities, backoff) and HTTP transport (five partner endpoints, optional push).
- `efk check` (C1–C9), `efk start` (TUI, `--web`, `--headless`, `--check`, `--demo`), `efk order create|watch`, `efk scenarios list`, `efk --version`.
- Vendored contract: strict schemas for what the kit emits, loose for what remi returns, 31 frozen samples and `SOURCE.json`.
