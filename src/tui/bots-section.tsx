import { Box, Text } from 'ink'
import { type BotRow, linkLabel, pad } from './model'

const age = (ms: number | null) => (ms === null ? '  never' : `${String(Math.round(ms / 1000)).padStart(5)}s`)

/**
 * The fleet, one row per bot. `link` carries the manual pin as a `*` (see `linkLabel`): without it a
 * bot pinned online by `o` looks exactly like a bot its scenario happens to have online, and the
 * partner cannot tell whether the scenario is still driving it.
 */
export function BotsSection({
    rows,
    selected,
    controlsAvailable,
    offlinePins,
    note,
}: {
    rows: BotRow[]
    selected: number
    controlsAvailable: boolean
    offlinePins: Record<string, boolean | null>
    note: string | null
}) {
    return (
        <Box flexDirection='column'>
            <Text
                dimColor
            >{`  ${pad('bot', 14)} ${pad('link', 6)} ${pad('avail', 6)} ${pad('batt', 5)} ${pad('door', 12)} ${pad('command', 30)} ${pad('age', 7)} ${pad('seq', 8)} drops`}</Text>
            {rows.map((r, i) => (
                <Box key={r.botId}>
                    <Text color={i === selected ? 'cyan' : undefined}>{i === selected ? '▶ ' : '  '}</Text>
                    <Text bold={i === selected}>{pad(r.botId, 14)} </Text>
                    <Text color={r.connected ? 'green' : 'red'}>{pad(linkLabel(r.connected, offlinePins[r.botId]), 6)} </Text>
                    <Text color={r.available ? 'green' : 'yellow'}>{pad(r.available ? 'yes' : 'no', 6)} </Text>
                    <Text color={r.batteryPercentage < 20 ? 'red' : undefined}>{pad(`${r.batteryPercentage}%`, 5)} </Text>
                    <Text color={r.door === 'stalled' ? 'red' : undefined}>{pad(r.door, 12)} </Text>
                    <Text>{pad(r.command, 30)} </Text>
                    <Text dimColor>{age(r.lastPublishedAgeMs)} </Text>
                    <Text dimColor>{pad(r.seq === null ? '—' : String(r.seq), 8)} </Text>
                    <Text color={r.dropped > 0 ? 'red' : 'gray'}>{r.dropped}</Text>
                </Box>
            ))}
            {note !== null && (
                <Box marginTop={1}>
                    <Text color='yellow'>{note}</Text>
                </Box>
            )}
            <Box marginTop={1}>
                <Text dimColor>
                    {controlsAvailable
                        ? '↑↓ select · a available · d door · o offline · b blocked/unblocked · Tab/←→ section · q quit'
                        : 'manual keys need the simulated driver (your driver is in charge) · Tab/←→ section · q quit'}
                </Text>
            </Box>
            {controlsAvailable && (
                <Box>
                    <Text dimColor>
                        {'  o cycles the link: scenario → down* → up* → scenario · * = pinned by hand, the scenario is not driving it'}
                    </Text>
                </Box>
            )}
        </Box>
    )
}
