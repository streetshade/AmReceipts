# syntax=docker/dockerfile:1

# AmReceipts production image.
#
# Multi-stage so the runtime carries the built app and its traced dependencies,
# but none of the toolchain that produced them. Both stages share one base
# image on purpose: Prisma compiles a query engine for the exact platform it is
# generated on, and a build stage on a different libc would produce an engine
# the runtime cannot load.
#
# Debian slim rather than Alpine, deliberately. Alpine uses musl, and Prisma's
# engines plus anything with a prebuilt native binary need the musl-specific
# build - a class of failure that appears only at runtime, in production.

# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# openssl is a Prisma runtime requirement and is not in the slim base.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Copied before the source so this layer is cached until dependencies actually
# change - editing a component should not reinstall node_modules.
COPY package.json package-lock.json ./
# The schema is copied HERE, before the install, because package.json has a
# `postinstall` of `prisma generate` - npm ci runs it, and without the schema
# the very first build stage fails. It changes rarely, so it costs no caching.
COPY prisma ./prisma
# `npm ci` not `npm install`: it installs exactly the lockfile and fails loudly
# when the two have drifted, which is the whole point of committing a lockfile.
# --include=dev because the build needs typescript, tailwind and @types.
RUN npm ci --include=dev

# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time only. Prisma reads DATABASE_URL when it generates, and Next
# evaluates env at build; neither value is used at runtime, and none is a
# secret. Real configuration arrives through the environment at `docker run`.
ENV DATABASE_URL="file:./build.db" \
    AUTH_SECRET="build-time-placeholder" \
    NEXT_TELEMETRY_DISABLED=1

# `npm run build` already runs `prisma generate` first (see package.json).
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Never run the app as root. `node` already exists in this base image.
RUN mkdir -p /app/public/uploads /app/data && chown -R node:node /app

# The standalone bundle carries its own minimal node_modules; static assets and
# public/ sit outside it and must be copied separately.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Prisma is the one thing standalone tracing regularly gets wrong: the client
# and its platform-specific engine live under node_modules/.prisma, which the
# tracer may miss. Copying them explicitly turns a mystifying runtime error
# into a build-time guarantee.
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma/client ./node_modules/@prisma/client

# The schema ships for reference and for the client to resolve against. Note it
# does NOT make `prisma db push` runnable here - the CLI is a devDependency and
# is deliberately not in this image. Schema changes are applied with the
# `migrate` stage below, which has the full toolchain.
COPY --from=builder --chown=node:node /app/prisma ./prisma

USER node
EXPOSE 3000

# Hits a real route rather than just checking the port, so a process that is
# up but failing to render is still reported unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
# Schema application. Built from `builder`, so it has the Prisma CLI the
# runtime image deliberately lacks - keeping ~50MB of tooling out of the image
# that faces the internet.
#
#   docker compose --profile migrate run --rm migrate
#
# Run this on first deploy and after any schema change, against the same
# DATABASE_URL and volume the app uses.
FROM builder AS migrate
ENV NODE_ENV=production
# Runs as `node`, matching the runtime stage. Docker seeds a new named volume
# from the image directory INCLUDING its ownership, so a migration running as
# root would create a root-owned database file that the unprivileged app could
# then never write to - a permissions failure that only appears on first write.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
CMD ["npx", "prisma", "db", "push"]
