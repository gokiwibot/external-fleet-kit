#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so a clone needs no build step.
// The second argument to register() is the parent URL tsx resolves its own hooks from; it must be
// THIS file's URL, not the process working directory: `efk` is run from the partner's project root,
// and pathToFileURL('./') would make the loader resolve against that directory instead of the kit.
import { register } from 'node:module'

register('tsx/esm', import.meta.url)
await import('../src/cli/index.ts')
