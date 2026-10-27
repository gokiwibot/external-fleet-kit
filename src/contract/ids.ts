/**
 * Identifier grammars, copied from /docs/external-fleets.
 *
 * `BOT_ID_REGEX` is applied to the WHOLE id: the fleet prefix (`ACME-`) is made of the same
 * characters, so one regex covers it. The prefix check is a separate concern (`hasBotIdPrefix`),
 * exactly as the roster service on the remi side does it.
 */

/** The partner namespace: an MQTT topic segment and the middle of every client id. No hyphen. */
export const NAMESPACE_REGEX = /^[a-z0-9_]+$/

/** FleetBot grammar: letters, digits, `_`, `.`, `-`. Nothing that MQTT reads (`/`, `+`, `#`), no whitespace, ASCII only. */
export const BOT_ID_REGEX = /^[A-Za-z0-9_.-]+$/

/** Total length of a bot id, prefix included. */
export const BOT_ID_MAX_LENGTH = 64

export function isValidNamespace(namespace: string): boolean {
    return NAMESPACE_REGEX.test(namespace)
}

export function isValidBotId(id: string): boolean {
    return id.length > 0 && id.length <= BOT_ID_MAX_LENGTH && BOT_ID_REGEX.test(id)
}

/** `ACME-0142` has prefix `ACME-`; the prefix alone is not an id. */
export function hasBotIdPrefix(id: string, prefix: string): boolean {
    return id.length > prefix.length && id.startsWith(prefix)
}
