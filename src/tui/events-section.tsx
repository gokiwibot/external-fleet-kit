import { Box, Text } from 'ink'
import { type EventRow, hhmmss, pad } from './model'

export function EventsSection({ rows }: { rows: EventRow[] }) {
    return (
        <Box flexDirection='column'>
            {rows.slice(0, 40).map((e) => (
                <Box key={e.id}>
                    <Text dimColor>{hhmmss(e.at)} </Text>
                    <Text>{pad(e.botId, 14)} </Text>
                    <Text color={e.type === 'blocked' ? 'yellow' : 'green'}>{pad(e.type, 10)} </Text>
                    <Text color={e.delivered ? 'green' : 'red'}>{e.delivered ? 'delivered' : 'not delivered'}</Text>
                    {e.detail && <Text dimColor> {e.detail}</Text>}
                </Box>
            ))}
            {rows.length === 0 && <Text dimColor>no events emitted yet</Text>}
        </Box>
    )
}
