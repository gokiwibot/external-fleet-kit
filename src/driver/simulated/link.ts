/** online / offline / flapping. In MQTT the transport closes the bot's connection for real when this says false. */
import type { BotScenario } from './scenario'

export interface Link {
    shouldBeConnected(nowMs: number): boolean
}

export function createLink(spec: BotScenario['link'], startedAtMs: number): Link {
    return {
        shouldBeConnected(nowMs) {
            if (spec.mode === 'online') return true
            if (spec.mode === 'offline') return false
            const phase = (nowMs - startedAtMs) % spec.flapPeriodMs
            return phase < spec.flapPeriodMs / 2
        },
    }
}
