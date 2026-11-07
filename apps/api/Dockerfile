# syntax=docker/dockerfile:1
# Jekimo API image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t jekimo-api .
# The image also carries the migration runner, `node dist/migrate.mjs`, and
# the operator command, `jekimo admin reset-password <email>`.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build -w @jekimo/api \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    JEKIMO_API_HOST=0.0.0.0 \
    JEKIMO_API_PORT=8080 \
    JEKIMO_MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/packages/storage-postgres/migrations ./migrations
RUN printf '#!/bin/sh\nexec node --enable-source-maps /app/dist/cli.mjs "$@"\n' > /usr/local/bin/jekimo \
 && chmod 755 /usr/local/bin/jekimo
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.JEKIMO_API_PORT || 8080) + '/readyz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
