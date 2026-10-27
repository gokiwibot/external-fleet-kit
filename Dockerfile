# One image, one role: `efk start --headless`. Copy it as is; nothing in it knows your driver.
FROM node:22-slim

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

# NOT `--prod`: the kit has no build step, it RUNS on tsx (`bin/efk.mjs` registers it), and tsx is a
# devDependency. A production-only install would produce an image that cannot execute a single line.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY . .

# The lock and the seq counters live here, on the volume, never in the immutable /app. remi orders a
# bot's states by timestamp first and uses seq only to break a tie, so losing the counters is harmless
# with a correct clock; keeping them keeps seq increasing across restarts, as the contract asks.
RUN mkdir -p /state && chown node:node /state
ENV EFK_STATE_DIR=/state

USER node
EXPOSE 4300
ENTRYPOINT ["sh", "docker/entrypoint.sh"]
