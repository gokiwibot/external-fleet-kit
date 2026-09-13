import { Box, Text } from 'ink'
import { type CommandRow, hhmmss, pad } from './model'

/** Newest first. Resends of one id are one row with `×N`; echo latency is the D5 signal the partner cares about. */
export function CommandsSection({ rows }: { rows: CommandRow[] }) {
    return (
        <Box flexDirection='column'>
            <Text
                dimColor
            >{`${pad('last', 8)} ${pad('bot', 14)} ${pad('type', 18)} ${pad('id', 26)} ${pad('sends', 5)} ${pad('outcome', 30)} echo`}</Text>
            {rows.slice(0, 40).map((c) => (
                <Box key={`${c.botId}:${c.commandId}`}>
                    <Text dimColor>{hhmmss(c.lastAt)} </Text>
                    <Text>{pad(c.botId, 14)} </Text>
                    <Text>{pad(c.type, 18)} </Text>
                    <Text>{pad(c.commandId, 26)} </Text>
                    <Text color={c.sends > 1 ? 'yellow' : undefined}>{pad(`×${c.sends}`, 5)} </Text>
                    <Text
                        color={
                            c.outcome.startsWith('4') ||
                            c.outcome.startsWith('5') ||
                            c.outcome.startsWith('rejected') ||
                            c.outcome.startsWith('no response')
                                ? 'red'
                                : c.outcome === 'pending'
                                  ? 'gray'
                                  : 'green'
                        }
                    >
                        {pad(c.outcome, 30)}{' '}
                    </Text>
                    <Text dimColor>{c.echoLatencyMs === null ? '—' : `${c.echoLatencyMs} ms`}</Text>
                </Box>
            ))}
            {rows.length === 0 && <Text dimColor>no commands received yet — create an order with `efk order create`</Text>}
        </Box>
    )
}
