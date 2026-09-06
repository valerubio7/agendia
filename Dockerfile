# syntax=docker/dockerfile:1
# Keep these references in deploy/images.lock in sync; both stages are immutable.
FROM oven/bun@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS builder
WORKDIR /build
COPY package.json bun.lock tsconfig.json tsconfig.base.json biome.jsonc ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN bun install --frozen-lockfile
RUN bun build apps/api/src/index.ts --target=bun --outdir /release/api \
 && bun build apps/whatsapp-manager/src/index.ts --target=bun --outdir /release/whatsapp-manager \
 && bun build apps/message-worker/src/index.ts --target=bun --outdir /release/message-worker \
 && bun build scripts/release-entrypoint-config.ts --target=bun --outdir /release/runtime-config
RUN AGENDIA_API_ORIGIN=http://api:3001 NEXT_TELEMETRY_DISABLED=1 bun run --cwd apps/web build \
 && mkdir -p /release/web \
 && cp -a apps/web/.next/standalone/. /release/web/ \
 && mkdir -p /release/web/apps/web/.next \
 && cp -a apps/web/.next/static /release/web/apps/web/.next/static \
 && if [ -d apps/web/public ]; then cp -a apps/web/public /release/web/apps/web/public; fi
# P0 proves Bun emits the node-rs native assets alongside release bundles.
RUN test -n "$(find /release/api -name 'argon2.linux-x64*' -print -quit)"

FROM oven/bun@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS runtime
WORKDIR /opt/agendia
COPY --from=builder --chown=10001:10001 /release/api ./api
COPY --from=builder --chown=10001:10001 /release/whatsapp-manager ./whatsapp-manager
COPY --from=builder --chown=10001:10001 /release/message-worker ./message-worker
COPY --from=builder --chown=10001:10001 /release/web ./web
COPY --from=builder --chown=10001:10001 /release/runtime-config ./runtime-config
COPY --chown=10001:10001 deploy/entrypoint /opt/agendia/bin/agendia
RUN chmod 0555 /opt/agendia/bin/agendia
USER 10001:10001
ENTRYPOINT ["/opt/agendia/bin/agendia"]
