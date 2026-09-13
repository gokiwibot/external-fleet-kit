#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so a clone needs no build step.
//
// `tsx/esm/api`'s own `register()`, NOT `node:module`'s `register('tsx/esm', …)`: tsx 4 refuses the
// latter outright ("tsx must be loaded with --import instead of --loader", because that path goes
// through the loader API node deprecated in 20.6). It is also what settles the resolution question
// the old comment worried about — `tsx/esm/api` is resolved as an ordinary import relative to THIS
// file, so it is found in the kit's node_modules no matter which directory `efk` was run from, and
// `../src/cli/index.ts` below is likewise relative to the kit rather than to process.cwd().
import { register } from 'tsx/esm/api'

register()
await import('../src/cli/index.ts')
