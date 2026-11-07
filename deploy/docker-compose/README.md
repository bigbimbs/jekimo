# Docker Compose deployment

| File | Purpose |
| --- | --- |
| [`docker-compose.yml`](docker-compose.yml) | Production stack for one VPS: Caddy for HTTPS, the published `ghcr.io/bigbimbs/jekimo-api` and `jekimo-worker` images pinned by `JEKIMO_VERSION`, a one-shot `migrate` job, and an optional local PostgreSQL (`COMPOSE_PROFILES=local-db`). Only Caddy publishes ports. |
| [`Caddyfile`](Caddyfile) | Caddy site for `JEKIMO_DOMAIN`, with automatic certificates. |
| [`.env.example`](.env.example) | Template for the production `.env`. |
| [`postgres-init/10-jekimo.sh`](postgres-init/10-jekimo.sh) | Runs once on an empty local-db volume: creates the restricted `jekimo` account and database and removes the superuser's password. |
| [`docker-compose.dev.yml`](docker-compose.dev.yml) | Local development stack built from source, every port on loopback. Not a production deployment. |

Install guide: [docs/install-vps.md](../../docs/install-vps.md). Database flows and credential handling: [docs/database-setup.md](../../docs/database-setup.md). Backups: [docs/backups-and-restore.md](../../docs/backups-and-restore.md). Local development: [docs/local-development.md](../../docs/local-development.md).

The dashboard image (`apps/web`) does not exist yet; `docker-compose.yml` and the `Caddyfile` have a commented placeholder for it.

Keep secrets in `.env` only, never in these files. The production Compose file passes each service only the variables it reads, so the PostgreSQL superuser password never reaches the API or worker.
