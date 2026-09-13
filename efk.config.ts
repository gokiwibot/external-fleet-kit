import { defineConfig } from './src/config'
import { simulated } from './src/driver/simulated'

export default defineConfig({
    // Swap for `(botId) => new MyRobotDriver(botId)` once you have copied the template.
    // EFK_SCENARIO is declared in the .env schema and is what `efk start --scenario <name>` sets.
    driver: simulated({ scenario: process.env.EFK_SCENARIO ?? 'default' }),
    fleet: {
        // Whether a navigate_to sent during another navigation is accepted and replaces it.
        // remi reads this from the capabilities document you publish (contract, FleetCapabilities).
        supportsCommandInterrupt: true,
    },
})
