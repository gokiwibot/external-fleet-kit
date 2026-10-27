# Security policy

Report a vulnerability in this kit privately, through **Report a vulnerability** in this repository's **Security** tab (GitHub private vulnerability reporting). Do not open a public issue for it.

## Scope

- **In scope:** the code in this repository — the fleet manager, the simulator, the CLI, the transports and the vendored contract.
- **Out of scope:** remi and Robot.com's services, including the endpoints and the broker the kit connects to. Report those through your Robot.com onboarding contact.

Never include credentials in a report: no API keys, no broker passwords, no `.env`. `pnpm efk check --json` contains no secrets and is safe to attach.
