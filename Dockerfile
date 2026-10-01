FROM oven/bun:1.4.0 AS base
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

FROM base AS runtime
USER bun
CMD ["bun", "run", "scripts/start-api.ts"]

FROM base AS web-build
ENV AGENDIA_API_ORIGIN=http://api:3001
RUN bun run --cwd apps/web build

FROM web-build AS web
USER bun
WORKDIR /app/apps/web
CMD ["bun", "--bun", "./node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
