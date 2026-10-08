# TimeHero, self-hosted. docker-compose.yml runs it with PostgreSQL and the
# scheduled jobs; docs/SELF-HOSTING.md is the walkthrough.
#
#   target app    the server: Next's standalone output, `node server.js`
#   target tools  the full source and dependencies, for migrations,
#                 `npm run setup` and `scripts/import.ts`

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# `npm ci` runs `prisma generate`, and prisma.config.ts reads DATABASE_URL.
# Nothing connects during the build.
RUN DATABASE_URL=postgresql://build@localhost:5432/build npm ci --no-audit --no-fund

FROM deps AS tools
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Migrations, setup and the import only read /app and talk to the database;
# none of them needs root. The files stay root-owned, so not writable either.
USER node

FROM tools AS build
# The build writes .next into /app.
USER root
# lib/env.ts parses these at build time; the real values arrive at runtime.
RUN DATABASE_URL=postgresql://build@localhost:5432/build \
    AUTH_SECRET=build-only-placeholder-not-used-at-runtime \
    npm run build

FROM node:22-alpine AS app
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Standalone output leaves out the static assets and public/, which the
# server still serves.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node docker/scheduler.mjs ./docker/scheduler.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server.js"]
