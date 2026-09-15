/**
 * MQTT topics and client ids of the contract (page section "MQTT mode").
 *
 * The client id is `fleet-<namespace>-<bot_id>-hb`. The namespace cannot contain a hyphen, so the
 * segment after `fleet-` is unambiguous even though bot ids do contain hyphens.
 */

import { isValidBotId } from './ids'

export type FleetTopicKind = 'state' | 'event' | 'command'

export function fleetTopic(namespace: string, botId: string, kind: FleetTopicKind): string {
    return `fleet/${namespace}/bot/${botId}/${kind}`
}

export function fleetClientId(namespace: string, botId: string): string {
    return `fleet-${namespace}-${botId}-hb`
}

/**
 * Client id used by `efk check` (rule C5). It keeps the mandatory `fleet-<namespace>-` prefix
 * but never equals a bot's client id: a CONNECT with a live bot's client id would evict that bot.
 */
export function fleetCheckClientId(namespace: string, random: () => number = Math.random): string {
    const suffix = Math.floor(random() * 0xffffffff)
        .toString(16)
        .padStart(8, '0')
    return `fleet-${namespace}-check-${suffix}-hb`
}

const COMMAND_TOPIC = /^fleet\/([a-z0-9_]+)\/bot\/([A-Za-z0-9_.-]+)\/command$/

/**
 * The regex alone is not the grammar: `isValidBotId` also caps the length at BOT_ID_MAX_LENGTH, and a
 * topic is untrusted input from the broker. Parsing must apply the SAME rule the kit applies to a
 * roster id, or a 300-character segment would pass here and fail everywhere downstream.
 */
export function parseCommandTopic(topic: string): { namespace: string; botId: string } | null {
    const match = COMMAND_TOPIC.exec(topic)
    if (!match?.[1] || !match[2]) return null
    if (!isValidBotId(match[2])) return null
    return { namespace: match[1], botId: match[2] }
}
