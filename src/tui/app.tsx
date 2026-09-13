import { Box, Text, useApp, useInput } from 'ink'
import { useState } from 'react'
import type { EventBus } from '../core/events'
import type { FleetManager } from '../core/fleet-manager'
import { BotsSection } from './bots-section'
import { CommandsSection } from './commands-section'
import { EventsSection } from './events-section'
import { LogSection } from './log-section'
import { controlsFor, guardToggle, nextOfflinePin, toggleAvailable } from './model'
import { useBusSnapshot } from './use-bus-snapshot'

const SECTIONS = ['BOTS', 'COMMANDS', 'EVENTS', 'LOG'] as const
type Section = (typeof SECTIONS)[number]

export function App({ bus, manager, demo, onQuit }: { bus: EventBus; manager: FleetManager; demo: boolean; onQuit: () => void }) {
    const { exit } = useApp()
    const { model, bots } = useBusSnapshot(bus, manager)
    const [section, setSection] = useState<Section>('BOTS')
    const [selected, setSelected] = useState(0)
    /** Tri-state per bot: `null`/absent = the scenario drives the link, `true` = pinned down, `false` = pinned up. */
    const [offline, setOffline] = useState<Record<string, boolean | null>>({})
    const [blocked, setBlocked] = useState<Record<string, boolean>>({})
    /** What the last toggle answered, when it answered something the row cannot show on its own. */
    const [note, setNote] = useState<string | null>(null)
    /**
     * ONE list. `bots` comes from `manager.bots()` through `botRows`, and `selected` indexes THAT
     * list. The earlier version selected into the `roster` array returned by `manager.start()` while
     * rendering `bots`: two lists that happen to agree today, and the day they do not — a bot that
     * fails to build a driver, a roster refreshed at runtime — the highlighted row and the bot the
     * fault keys act on are different bots, which is the worst possible bug in a fault-injection UI.
     */
    const selectedBot = bots[selected]?.botId
    // Guarded end to end: this runs in the render body, where a driver that throws — from the lookup
    // or from one of the five property reads — would unmount the screen and take the fleet with it.
    const controls = controlsFor(manager, selectedBot)

    useInput((input, key) => {
        if (input === 'q' || (key.ctrl && input === 'c')) {
            // One way out for the whole process: `onQuit` is `efk start`'s shutdown. No synthetic
            // SIGINT — a UI component must not raise process-wide signals.
            onQuit()
            exit()
            return
        }
        if (key.tab || key.rightArrow) setSection((s) => SECTIONS[(SECTIONS.indexOf(s) + 1) % SECTIONS.length] ?? 'BOTS')
        if (key.leftArrow) setSection((s) => SECTIONS[(SECTIONS.indexOf(s) + SECTIONS.length - 1) % SECTIONS.length] ?? 'BOTS')
        if (section !== 'BOTS') return
        if (key.upArrow || key.downArrow) {
            // The note below the table answers for ONE bot, and it names it. Clearing it on a move
            // keeps it from reading as a comment on whichever row is highlighted now.
            setNote(null)
            if (key.upArrow) setSelected((i) => Math.max(0, i - 1))
            else setSelected((i) => Math.min(bots.length - 1, i + 1))
        }
        if (!selectedBot || !controls) return
        // Every driver call below goes through `guardToggle`: a driver that throws must cost the
        // keystroke and one note, not the screen and the simulation behind it.
        const refusal = guardToggle(selectedBot, () => {
            const runtime = manager.bots().find((b) => b.botId === selectedBot)
            if (input === 'a' && runtime) {
                // Reads back what the driver actually did: on a flat battery the toggle cannot win,
                // and a control that silently does nothing is worse than one that says why (see
                // `toggleAvailable`).
                setNote(toggleAvailable(controls, runtime).note)
            }
            if (input === 'd') {
                controls.toggleDoorLocally()
                runtime?.touch()
            }
            if (input === 'o') {
                // Three states, and `null` is the one that gives the bot back to its scenario.
                const next = nextOfflinePin(offline[selectedBot])
                controls.setOffline(next)
                setOffline((m) => ({ ...m, [selectedBot]: next }))
                runtime?.touch()
            }
            if (input === 'b') {
                const next = !(blocked[selectedBot] ?? false)
                if (next) controls.emitBlocked('operator_test', 'blocked from the efk TUI')
                else controls.emitUnblocked()
                setBlocked((m) => ({ ...m, [selectedBot]: next }))
            }
        })
        if (refusal !== null) setNote(refusal)
    })

    return (
        <Box flexDirection='column' padding={1}>
            {demo && (
                <Box marginBottom={1}>
                    <Text backgroundColor='red' color='white' bold>
                        {' DEMO MODE — not connected to remi. Everything below is invented by the kit. '}
                    </Text>
                </Box>
            )}
            <Box marginBottom={1}>
                <Text bold>efk </Text>
                <Text dimColor>
                    · {manager.config()?.namespace ?? '?'} · {bots.length} bots ·{' '}
                </Text>
                {SECTIONS.map((s) => (
                    <Text key={s} color={s === section ? 'cyan' : 'gray'} bold={s === section}>
                        {' '}
                        {s}{' '}
                    </Text>
                ))}
            </Box>
            {section === 'BOTS' && (
                <BotsSection rows={bots} selected={selected} controlsAvailable={controls !== null} offlinePins={offline} note={note} />
            )}
            {section === 'COMMANDS' && <CommandsSection rows={model.commands} />}
            {section === 'EVENTS' && <EventsSection rows={model.events} />}
            {section === 'LOG' && <LogSection rows={model.log} />}
        </Box>
    )
}
