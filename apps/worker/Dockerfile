# syntax=docker/dockerfile:1
# Jekimo worker image. Build from the repository root:
#   docker build -f apps/worker/Dockerfile -t jekimo-worker .

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build -w @jekimo/worker \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/dist ./dist
USER node
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
