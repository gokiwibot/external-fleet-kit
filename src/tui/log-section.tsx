import { Box, Text } from 'ink'
import { hhmmss, type LogRow, pad } from './model'

const COLOR: Record<LogRow['level'], string | undefined> = { debug: 'gray', info: undefined, warn: 'yellow', error: 'red' }

/** Dropped states are red whatever the level: they are the one thing the partner must not miss. */
export function LogSection({ rows }: { rows: LogRow[] }) {
    return (
        <Box flexDirection='column'>
            {rows.slice(0, 40).map((l) => (
                <Box key={l.id}>
                    <Text dimColor>{hhmmss(l.at)} </Text>
                    <Text color={l.dropped ? 'red' : COLOR[l.level]}>{pad(l.level, 5)} </Text>
                    <Text color={l.dropped ? 'red' : undefined}>{l.message}</Text>
                </Box>
            ))}
        </Box>
    )
}
