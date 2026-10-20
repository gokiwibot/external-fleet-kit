# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer. Each version states the contract version and the `data.ts` commit its samples are frozen against.

## [Unreleased]

Absorbed from the first fork of the kit that drives real robots. Only what any partner needs; that fork's own driver stays in the fork.

### Added
- `Dockerfile`, `docker/entrypoint.sh` and `.dockerignore`; README section *Running it in a container*.
- `EFK_STATE_DIR` moves `.efk.lock` and `.efk-state.json` onto a volume. Declared in the `.env` schema.
- `GET /healthz` on the HTTP surface, before the bearer check, for probes that send no headers. It says the process is listening, nothing about the fleet.

### Documentation
- The kit is single-instance (`replicas: 1`, `Recreate`, `ReadWriteOncePod`), and the README now says so.

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
