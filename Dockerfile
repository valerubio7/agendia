FROM oven/bun:1.4.0 AS base
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

FROM base AS web-build
ENV AGENDIA_API_ORIGIN=http://api:3001
RUN bun run --cwd apps/web build

FROM web-build AS application
USER bun
WORKDIR /app
CMD ["bun", "run", "scripts/dev/start-api.ts"]
