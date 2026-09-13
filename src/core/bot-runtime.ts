/**
 * One bot = one driver + one ledger + the assembly of BotState. Everything above the driver that the
 * contract requires happens here (design §5, responsibilities table): idempotency, expiry and
 * capability checks before the driver is called, the rejected/failed/DRIVER_ERROR split, the seq,
 * the timestamp, zod validation before publishing, and the cadence decision per tick.
 *
 * THE PUBLISH SEAM (ruling R4). A state is not published because the kit decided to publish it — it
 * is published when a transport says it left the process. So `assemble()` builds a state and touches
 * nothing else, and `tick()` takes the transport with it: it hands the state, `seq` stamped, to
 * `publish`, and only a `true` answer consumes the counter and tells the ledger the outcome was
 * seen. The global constraint is that `seq` increments ON PUBLISH; without this seam an MQTT bot
 * whose link is down burns a counter every 15 s for states nobody receives, an HTTP bot that remi
 * polls (push off, the default) advances it on every tick for ever, and — worse — a rejection gets
 * marked published without ever reaching remi, so remi never learns the outcome of a command it
 * asked for. There is deliberately no way to get a seq-stamped state out of this module without
 * handing over the transport that will carry it.
 *
 * Polling is the other half of the same rule. In HTTP polling mode nothing is ever pushed: the
 * answer to `GET /bots` IS the delivery, so the transport calls `markServed()` with the state it
 * served. That drains the ledger exactly like a confirmed push and consumes no `seq`, because a
 * poll carries none (`data.ts:676`). Draining is the only way the ledger's queue of unpublished
 * outcomes ever empties, so a state that reached remi and was not acknowledged strands an outcome.
 */
import {
    type BotCapabilities,
    type BotCommand,
    type BotState,
    botStateSchema,
    type CommandStatus,
    type DestinationValidation,
} from '../contract/schemas'
import type { DriverAccept, DriverSnapshot, Position, RobotDriver } from '../driver/robot-driver'
import type { Cadence } from './cadence'
import type { CommandLedger, LedgerEntry } from './command-ledger'
import type { CommandOutcome, EventBus } from './events'
import type { Seq } from './seq'

export type BotRuntimeDeps = {
    botId: string
    driver: RobotDriver
    ledger: CommandLedger
    cadence: Cadence
    seq: Seq
    bus: EventBus
    now: () => number
    fleet: { supportsCommandInterrupt: boolean }
}

/**
 * Hands one assembled state to the transport and answers whether it REALLY left the process: MQTT
 * returns false for a bot whose link is down, HTTP returns false whenever push is off. A `false` (or
 * a throw) costs the state and nothing else — no seq, no acknowledgement to the ledger.
 */
export type PublishState = (state: BotState) => boolean | Promise<boolean>

export type AssembleResult = { ok: true; state: BotState } | { ok: false; reason: string }

export interface BotRuntime {
    readonly botId: string
    start(): Promise<void>
    stop(): Promise<void>
    handleCommand(command: BotCommand, via: 'mqtt' | 'http'): Promise<CommandOutcome>
    /**
     * The cadence tick, delivery included. Returns the state that was published — `seq` stamped — or
     * null when the tick was not due, the state did not assemble, or the transport refused it.
     * `publish` is what makes the difference between the three: see THE PUBLISH SEAM above.
     */
    tick(nowMs: number, publish: PublishState): Promise<BotState | null>
    /** The state WITHOUT seq: this is what a poll (`GET /bots`) serves, and a poll consumes no counter. */
    assemble(nowMs: number): AssembleResult
    /**
     * Acknowledge that a state built by `assemble()` really reached remi, which in HTTP polling mode
     * is what answering `GET /bots` means. It drains the ledger's queue of unpublished outcomes, so
     * the next command's outcome can take the single `current_command` slot — and it consumes no
     * `seq`, because the state it acknowledges carries none.
     */
    markServed(state: BotState): void
    /**
     * The last state that DID assemble, with its own (older) timestamp. `GET /bots` must answer with
     * every bot on every call, so a bot whose driver momentarily lost its position is served from
     * here instead of vanishing from the list; remi reads the age from `timestamp` and decides.
     * Null until the bot has ever had a position — then, and only then, it is omitted and counted.
     */
    lastValidState(): BotState | null
    currentCommand(): CommandStatus | null
    /**
     * For `GET /bots/:bot_id/commands/*` (Task 14). The live entry: read it, never mutate it — and
     * check `internalCode` before rendering `status`, because an entry displaced by a newer
     * navigation carries the kit-internal `REPLACED` code that must not reach remi (see
     * `publishableCommand`, which is the same rule for the state).
     */
    ledgerEntry(id: string): LedgerEntry | undefined
    /** For `POST /destinations/validate` (Task 14). */
    validateDestination(position: Position): Promise<DestinationValidation>
    snapshot(): DriverSnapshot
    capabilities(): BotCapabilities
    dropped(): number
    /** Marks the snapshot dirty so the next tick publishes (used by the TUI toggles, and by a transport that just reconnected). */
    touch(): void
}

export function createBotRuntime(deps: BotRuntimeDeps): BotRuntime {
    const { botId, driver, ledger, cadence, seq, bus, now } = deps
    /** When the cadence last SPENT a tick on this bot, delivered or not — see the note in `tick`. */
    let lastAttemptAt: number | null = null
    let changed = false
    let droppedCount = 0
    let lastSnapshotKey = ''
    let lastValid: BotState | null = null
    /** One publish at a time per bot: the seq is reserved across the await and must not be raced. */
    let publishing = false
    const receivedAt = new Map<string, number>()
    const unsubscribes: Array<() => void> = []

    const capabilities = (): BotCapabilities => {
        const caps = driver.capabilities()
        return { has_door: caps.hasDoor, supported_commands: caps.supportedCommands }
    }

    const markChanged = () => {
        changed = true
    }

    const echo = (commandId: string) => {
        const at = receivedAt.get(commandId)
        if (at !== undefined) {
            bus.emit('command.echoed', { botId, commandId, echoLatencyMs: now() - at })
            receivedAt.delete(commandId)
        }
    }

    /**
     * What may go into `current_command`. `REPLACED` is the ledger's internal marker for a navigation
     * displaced by a newer one, and it must never reach remi: the contract has no such outcome, and
     * `commandStatusSchema` would NOT stop it, because on a `failed` the error code is a free string.
     * A leak would be a perfectly valid state telling remi that a command it never cancelled failed
     * for a reason it has never heard of. The slot goes out empty instead — remi asked for the newer
     * navigation and is not waiting for this outcome, which is why the ledger does not queue it.
     */
    const publishableCommand = (): CommandStatus | null => {
        const status = ledger.current()
        if (!status) return null
        return ledger.get(status.id)?.internalCode === 'REPLACED' ? null : status
    }

    const wire = () => {
        unsubscribes.push(
            driver.on('commandState', (id, state, error) => {
                // Restating the state a command already holds is idempotent and silent. Drivers that
                // emit `arrived` AND `commandState(succeeded)` — the simulated one does, and so do
                // most real ones — would otherwise log a warning on every single navigation, which
                // trains the partner to ignore the warnings that matter.
                if (ledger.get(id)?.status.state === state) return
                if (state === 'executing') {
                    if (ledger.markExecuting(id)) markChanged()
                    else bus.emit('log', { level: 'warn', botId, message: `commandState(${id}, executing) ignored: unknown or terminal` })
                    return
                }
                if (state === 'failed') {
                    // The ledger refuses a failure with no reason, and it is right to: the contract
                    // requires an error on a failed CommandStatus, so the status would be dropped by
                    // the schema on the way out and remi would never learn how the command ended.
                    // Saying so beats letting it look like an unknown id.
                    if (!error) {
                        bus.emit('log', {
                            level: 'warn',
                            botId,
                            message: `commandState(${id}, failed) ignored: a failure must carry an error`,
                        })
                        return
                    }
                    if (ledger.complete(id, 'failed', error)) markChanged()
                    else bus.emit('log', { level: 'warn', botId, message: `commandState(${id}, failed) ignored: unknown or terminal` })
                    return
                }
                if (ledger.complete(id, 'succeeded')) markChanged()
                else bus.emit('log', { level: 'warn', botId, message: `commandState(${id}, ${state}) ignored: unknown or terminal` })
            }),
            driver.on('arrived', (id) => {
                if (ledger.activeNavigation() !== id) {
                    bus.emit('log', { level: 'info', botId, message: `arrived(${id}) ignored: not the current navigation` })
                    return
                }
                ledger.markExecuting(id)
                if (ledger.complete(id, 'succeeded')) {
                    markChanged()
                    bus.emit('event.emitted', {
                        botId,
                        event: { bot_id: botId, type: 'arrived', command_id: id, occurred_at: new Date(now()).toISOString() },
                        delivered: false,
                    })
                }
            }),
            driver.on('blocked', (detail) =>
                bus.emit('event.emitted', {
                    botId,
                    event: { bot_id: botId, type: 'blocked', occurred_at: new Date(now()).toISOString(), detail },
                    delivered: false,
                }),
            ),
            driver.on('unblocked', () =>
                bus.emit('event.emitted', {
                    botId,
                    event: { bot_id: botId, type: 'unblocked', occurred_at: new Date(now()).toISOString() },
                    delivered: false,
                }),
            ),
            driver.on('stateChanged', markChanged),
        )
    }
    wire()

    const finish = (commandId: string, outcome: CommandOutcome, startedAt: number): CommandOutcome => {
        bus.emit('command.outcome', { botId, commandId, outcome, latencyMs: now() - startedAt })
        return outcome
    }

    const assemble = (nowMs: number): AssembleResult => {
        const snap = driver.snapshot()
        if (!snap.position) return { ok: false, reason: 'position is null: the driver does not know where the robot is' }
        // No `seq` here on purpose. `assemble` serves both the tick (which stamps the reserved seq
        // once the transport confirms) and the HTTP poll (which must not consume one). `seq.peek() + 1`
        // would hand the same number to every poll until something publishes — a counter that is not
        // monotonic is worse than no counter, and the contract says a poll may omit it (`data.ts:676`).
        const candidate = {
            bot_id: botId,
            timestamp: new Date(nowMs).toISOString(),
            available: snap.available,
            connected: snap.connected,
            position: snap.position,
            battery: { percentage: Math.round(snap.batteryPercentage) },
            ...(snap.speedMps !== undefined ? { motion: { speed_mps: Math.max(0, snap.speedMps) } } : {}),
            door: snap.door,
            current_command: publishableCommand(),
        }
        const parsed = botStateSchema.safeParse(candidate)
        if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
        lastValid = parsed.data
        return { ok: true, state: parsed.data }
    }

    /**
     * The one door to the ledger's queue of unpublished outcomes: a state that really reached remi,
     * pushed or served. Every delivery goes through here, and nothing else pops the queue.
     */
    const acknowledge = (state: BotState) => {
        if (state.bot_id !== botId || !state.current_command) return
        ledger.markPublished(state.current_command.id)
        echo(state.current_command.id)
    }

    return {
        botId,
        async start() {
            await driver.start({ now, log: (message, data) => bus.emit('log', { level: 'info', botId, message, data }) })
        },
        async stop() {
            for (const off of unsubscribes) off()
            await driver.stop()
        },
        async handleCommand(command, via) {
            const startedAt = now()
            bus.emit('command.received', { botId, command, via, receivedAt: startedAt })

            const known = ledger.get(command.id)
            if (known) return finish(command.id, { kind: 'duplicate', status: known.status }, startedAt)

            if (command.expires_at && Date.parse(command.expires_at) < now()) {
                ledger.reject(command.id, command.type, 'COMMAND_EXPIRED', 'expires_at is in the past')
                markChanged()
                return finish(command.id, { kind: 'rejected', code: 'COMMAND_EXPIRED', message: 'expires_at is in the past' }, startedAt)
            }
            if (!capabilities().supported_commands.includes(command.type)) {
                const message = `${command.type} is not in this bot's supported_commands`
                ledger.reject(command.id, command.type, 'UNSUPPORTED_COMMAND', message)
                markChanged()
                return finish(command.id, { kind: 'rejected', code: 'UNSUPPORTED_COMMAND', message }, startedAt)
            }

            const active = ledger.activeNavigation()
            if (command.type === 'navigate_to' && active !== null && active !== command.id && !deps.fleet.supportsCommandInterrupt) {
                const message = `navigation ${active} in progress and the fleet does not support interrupt`
                ledger.reject(command.id, command.type, 'BOT_BUSY', message)
                markChanged()
                return finish(command.id, { kind: 'rejected', code: 'BOT_BUSY', message }, startedAt)
            }

            let accept: DriverAccept
            try {
                accept = await dispatch(driver, command)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                bus.emit('log', { level: 'error', botId, message: `driver threw on ${command.type} ${command.id}: ${message}` })
                return finish(command.id, { kind: 'driver_error', message }, startedAt)
            }

            if (accept.kind === 'rejected') {
                ledger.reject(command.id, command.type, accept.code, accept.message, accept.correctionDistanceM)
                markChanged()
                return finish(
                    command.id,
                    { kind: 'rejected', code: accept.code, message: accept.message, correctionDistanceM: accept.correctionDistanceM },
                    startedAt,
                )
            }

            if (command.type === 'navigate_to' && active !== null && active !== command.id) ledger.replace(active)
            if (command.type === 'cancel_navigation' && active !== null) {
                // The kit ends the cancelled navigation, not the driver: the contract has no state for
                // "cancelled", so it stays `accepted`/`executing` for ever unless somebody closes it —
                // and with supports_command_interrupt: false that makes the bot answer BOT_BUSY to
                // every later navigate_to, i.e. a bot that can never be dispatched again. `CANCELLED`
                // is a kit error code on a `failed`, exactly like any other runtime failure.
                ledger.complete(active, 'failed', { code: 'CANCELLED', message: `cancelled by cancel_navigation ${command.id}` })
            }
            receivedAt.set(command.id, startedAt)
            const status = ledger.accept(
                command.id,
                command.type,
                accept.kind === 'accepted_with_correction' ? { position: accept.position, distanceM: accept.distanceM } : undefined,
            )
            // With nothing to cancel there is no robot work to wait for, so the cancel is done here;
            // with a navigation to stop, the driver reports `succeeded` when the wheels are still.
            if (command.type === 'cancel_navigation' && active === null) ledger.complete(command.id, 'succeeded')
            markChanged()
            return finish(command.id, { kind: 'accepted', status: ledger.get(command.id)?.status ?? status }, startedAt)
        },
        assemble,
        markServed: acknowledge,
        lastValidState: () => lastValid,
        async tick(nowMs, publish) {
            // A tick that overtook the publish in flight would reserve the same seq twice. Ticks for
            // one bot are serial; this guard is what makes that a property instead of a convention.
            if (publishing) return null
            const snap = driver.snapshot()
            const command = publishableCommand()
            const key = JSON.stringify([snap.available, snap.connected, snap.door, command?.id, command?.state])
            if (key !== lastSnapshotKey) {
                if (lastSnapshotKey !== '') changed = true
                lastSnapshotKey = key
            }
            const moving = (snap.speedMps ?? 0) > 0
            if (!cadence.shouldPublish({ nowMs, lastPublishedAtMs: lastAttemptAt, moving, changed })) return null
            const result = assemble(nowMs)
            // The cadence governs how often a bot RENDERS and OFFERS a state, not how often one lands:
            // whether it lands is the transport's business. Charging the attempt here — success or not
            // — is what keeps a bot whose link is down from re-assembling and re-validating four times
            // a second for hours on end. It costs freshness and nothing else, because every state is a
            // full snapshot: the next heartbeat carries everything the refused one carried, and a
            // transport that has just reconnected can call `touch()` instead of waiting for it.
            lastAttemptAt = nowMs
            changed = false
            if (!result.ok) {
                droppedCount += 1
                bus.emit('state.dropped', { botId, reason: result.reason })
                return null
            }
            // Reserved, not consumed: `seq.next()` runs below only if the transport confirms. The
            // guard above keeps ticks serial, so the reservation is still the next number by then.
            const state: BotState = { ...result.state, seq: seq.peek(botId) + 1 }
            let delivered = false
            publishing = true
            try {
                delivered = (await publish(state)) === true
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                bus.emit('log', { level: 'error', botId, message: `the transport threw publishing seq ${state.seq}: ${message}` })
            } finally {
                publishing = false
            }
            if (!delivered) return null
            seq.next(botId)
            // It has now been seen by remi, so the slot may go back to the running command on the next
            // assembly (CommandLedger, single-slot rule).
            acknowledge(state)
            return state
        },
        currentCommand: publishableCommand,
        ledgerEntry: (id) => ledger.get(id),
        validateDestination: (position) => driver.validateDestination(position),
        snapshot: () => driver.snapshot(),
        capabilities,
        dropped: () => droppedCount,
        touch: markChanged,
    }
}

function dispatch(driver: RobotDriver, command: BotCommand): Promise<DriverAccept> {
    const expiresAt = command.expires_at ? Date.parse(command.expires_at) : undefined
    switch (command.type) {
        case 'navigate_to': {
            const params = command.params as { lat: number; lng: number }
            return driver.navigateTo({ id: command.id, target: { lat: params.lat, lng: params.lng }, expiresAt })
        }
        case 'cancel_navigation':
            return driver.cancelNavigation({ id: command.id })
        case 'set_door': {
            const params = command.params as { state: 'open' | 'closed' }
            return driver.setDoor({ id: command.id, state: params.state })
        }
    }
}
