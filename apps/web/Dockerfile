# syntax=docker/dockerfile:1
# Jekimo dashboard image: the built single-page app served by Caddy on port
# 8080 as a non-root user. Build from the repository root:
#   docker build -f apps/web/Dockerfile -t jekimo-web .

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build -w @jekimo/web

FROM caddy:2-alpine
ENV XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data
RUN mkdir -p /etc/caddy/conf.d
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
