/**
 * `contract_version` this kit is frozen against.
 *
 * N2 keeps `2026-09` even though it adds `rejected`, `rejected_at`, the correction fields and
 * `FleetCapabilities`: those are ADDITIVE, and a partner frozen against the earlier text keeps
 * working. Only a breaking change — a field removed, a field turned required, a value whose meaning
 * moves — earns a new `contract_version`. So a mismatch here is a WARN in `efk check` C2, not a FAIL.
 */
export const CONTRACT_VERSION = '2026-09'
