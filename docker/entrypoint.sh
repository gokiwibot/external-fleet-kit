#!/bin/sh
set -e

# The lock guards against TWO efk processes publishing conflicting seq for the same bot. Inside a
# fresh container pid 1 always exists, so `acquireLock`'s liveness check can never reclaim the lock a
# killed predecessor left on the volume — the stale file would refuse every restart for ever. With
# `replicas: 1` and a `Recreate` strategy there is by construction no second instance to protect
# against, so removing it here is safe; with more than one replica it would NOT be.
rm -f "${EFK_STATE_DIR:-/state}/.efk.lock"

exec node bin/efk.mjs start --headless
