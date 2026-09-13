import { useEffect, useRef, useState } from 'react'
import type { EventBus } from '../core/events'
import type { FleetManager } from '../core/fleet-manager'
import { applyReplay, type BotRow, botRows, createModel, reduce, reportableDriverFailures, type TuiModel } from './model'

/**
 * Subscribes to the bus and folds every event into a ref; React state is refreshed on a fixed tick
 * (500 ms, like sim-bot's batch mode). A 200-bot fleet publishes several hundred events a second and
 * a terminal must not redraw per event.
 *
 * IT STARTS WITH WHAT IT MISSED. Nothing observes the bus until this effect runs, and by then the
 * connection, the roster, the capabilities — and any failure among them — have already fired. So the
 * first thing the effect does is fold `bus.replay()`, and only then subscribe. The two happen in one
 * synchronous block on purpose: an event emitted between them would be lost by the first and missed
 * by the second, and there is no point in the bus's life where nobody is listening for it.
 */
export function useBusSnapshot(bus: EventBus, manager: FleetManager, intervalMs = 500): { model: TuiModel; bots: BotRow[]; now: number } {
    const modelRef = useRef<TuiModel>(createModel())
    /** Bots whose driver has already been reported as throwing, so the LOG is not a twice-a-second drumbeat. */
    const reportedRef = useRef<Set<string>>(new Set())
    const [snapshot, setSnapshot] = useState<{ model: TuiModel; bots: BotRow[]; now: number }>(() => ({
        model: modelRef.current,
        bots: botRows(manager, modelRef.current, Date.now()),
        now: Date.now(),
    }))

    useEffect(() => {
        modelRef.current = applyReplay(modelRef.current, bus.replay(), Date.now())
        const off = bus.onAny((name, payload) => {
            modelRef.current = reduce(modelRef.current, name, payload as never, Date.now())
        })
        const publish = () => {
            const now = Date.now()
            const bots = botRows(manager, modelRef.current, now)
            // A driver that throws does it on every tick. `reportableDriverFailures` is what turns
            // that into one line per failure — and into a new line if the bot recovers and fails
            // again — instead of two lines a second for the rest of the run.
            for (const failure of reportableDriverFailures(bots, reportedRef.current)) {
                modelRef.current = reduce(modelRef.current, 'log', { level: 'error', botId: failure.botId, message: failure.message }, now)
            }
            setSnapshot({ model: modelRef.current, bots, now })
        }
        // Once immediately, so the replayed history is on screen at the first frame instead of after
        // the first tick: the panel is empty for half a second otherwise, which is exactly the
        // complaint the replay buffer exists to answer.
        publish()
        const timer = setInterval(publish, intervalMs)
        return () => {
            off()
            clearInterval(timer)
        }
    }, [bus, manager, intervalMs])

    return snapshot
}
