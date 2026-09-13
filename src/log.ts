/**
 * The kit's logger. Task 18 replaces the BODY of `createLogger` with the version that redacts keys
 * and values; the SIGNATURE here is already the final one, so that task changes nothing else.
 *
 * `sink` is the part this stub already has to get right, because `efk start` ships in this commit.
 *  - With the TUI mounted nothing may reach stdout or stderr — a stray line tears the screen — so
 *    the bus is the only sink and the TUI's LOG section is where the lines show up.
 *  - `--headless` has no screen to tear AND no observer on the bus: the TUI and the dashboard are
 *    what read it, and neither is mounted. A logger that only fed the bus would make the one mode
 *    with no UI completely silent — `efk start --headless` would report the fleet starting and then
 *    never mention that the broker is refusing every CONNECT, because the transport and the fleet
 *    manager report through `bus.emit('log', …)` and nothing would be listening. So in that mode the
 *    logger is also the bus's OBSERVER, which is the role `core/events.ts` describes for it.
 */
import pino, { type Logger } from 'pino'
import type { EventBus } from './core/events'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LoggerOptions = {
    sink: 'stderr' | 'bus'
    /** Values that must never appear in a line. Redaction itself lands in Task 18. */
    secrets: string[]
}

export function createLogger(level: LogLevel, bus: EventBus, opts: LoggerOptions): Logger {
    // Task 18 reads `opts.secrets` here. Referenced so the contract is visible, not silently dropped.
    void opts.secrets
    if (opts.sink === 'bus') {
        return pino({ level }, { write: (line: string) => bus.emit('log', { level: 'info', message: line.trim() }) })
    }
    const logger = pino({ level }, { write: (line: string) => void process.stderr.write(line) })
    // The bus carries what the core reports; without this it would be written to nobody. Not
    // unsubscribed: the logger lives as long as the process it logs for.
    bus.on('log', (entry) => {
        logger[entry.level]({ botId: entry.botId, ...entry.data }, entry.message)
    })
    return logger
}
