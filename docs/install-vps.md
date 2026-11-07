# Install on a VPS

This guide installs one Jekimo instance on one Linux VPS with the production Docker Compose file: Caddy for HTTPS, the published API and worker images, and either a local PostgreSQL container or an existing PostgreSQL server. It ends with a first event stored and a backup taken.

> **Before the first release.** Jekimo has no tagged release yet, so there is no versioned image to pin. To evaluate the install path now, take the files from `main` and set `JEKIMO_VERSION=edge`, which the [Images](../.github/workflows/images.yml) workflow publishes from every push to `main`. Do not run `edge` for data you care about. The web dashboard does not exist yet ([issue #31](https://github.com/bigbimbs/jekimo/issues/31)); until it does, setup and project management use the JSON API with `curl`, as shown below.

## Overview

```text
Internet ──80/443──> caddy (HTTPS, certificates) ──> api:8080 ──> durable queue ──> worker
                                                        │                            │
                                                        └──────── PostgreSQL ────────┘
                                                      (postgres service, or an existing server)
```

| Service | Image | What it does |
| --- | --- | --- |
| `caddy` | `caddy:2-alpine` | Terminates HTTPS and gets and renews the certificate. The only service with published ports. |
| `api` | `ghcr.io/bigbimbs/jekimo-api:<version>` | Ingestion (`POST /api/v1/ingest`), setup, sign-in, projects, keys, and the query API. |
| `worker` | `ghcr.io/bigbimbs/jekimo-worker:<version>` | Validates, redacts, fingerprints, stores, and expires events. |
| `migrate` | the API image | Applies database migrations and creates upcoming event partitions, then exits. `api` and `worker` start only after it succeeds. |
| `postgres` | `postgres:16-alpine` | Optional local database, enabled with the `local-db` profile. |

Why Caddy: it obtains and renews Let's Encrypt certificates on its own with a four-line configuration, redirects HTTP to HTTPS, and serves HTTP/2 and HTTP/3, so there is no certbot timer or renewal hook to maintain. It is a single static binary with a small, well-maintained official image. Any other reverse proxy works if it terminates TLS and forwards to `api:8080` with `X-Forwarded-For`.

## 1. Requirements and sizing

### Server

| Resource | Reference size | Notes |
| --- | --- | --- |
| CPU | 2 vCPU | `linux/amd64` or `linux/arm64`; images are published for both. |
| Memory | 4 GB | Includes PostgreSQL on the same host. |
| Disk | 80 GB SSD | See the storage formula below. |
| OS | A current 64-bit Linux with Docker support | Commands below are for Debian 12 or Ubuntu 24.04. |
| Software | Docker Engine with the Compose plugin 2.20 or newer | `docker compose version`. |

This reference VPS is sized for **1,000,000 accepted events a month across all projects at 30-day retention**, with bursts of 1,000 events a minute per project ([retention.md](retention.md#proposed-targets-for-the-first-release)). These are proposed targets, to be confirmed by measurement before the first release.

### Storage formula

```text
event storage = monthly events × average event size × (retention days ÷ 30) × 2
```

The average stored event is about **4 KiB** including indexes. The factor of 2 is the safety margin [retention.md](retention.md#proposed-targets-for-the-first-release) requires, for PostgreSQL overhead, bloat between vacuums, and growth. Add the operating system, Docker images (about 2 GB), container logs (capped at 50 MB per service by the Compose file), and local backups.

| Monthly events | Retention | Event storage (with safety factor) |
| --- | --- | --- |
| 1,000,000 | 30 days | about 8 GB |
| 1,000,000 | 90 days | about 23 GB |
| 3,000,000 | 14 days | about 11 GB |
| 5,000,000 | 30 days | about 39 GB |

A local backup is a compressed dump, usually a fraction of the database size; budget room for at least a week of them, or copy them off the server and keep fewer locally ([backups-and-restore.md](backups-and-restore.md)).

## 2. DNS

Create an `A` record (and `AAAA` if the VPS has IPv6) for the instance's host name, for example `jekimo.example.com`, pointing at the VPS. Wait until it resolves to the VPS address:

```bash
dig +short jekimo.example.com
```

SDKs will send events to `https://jekimo.example.com/api/v1/ingest`.

## 3. Firewall

Allow inbound TCP 22 (SSH), 80 (certificate issuance and the redirect to HTTPS), and 443, plus UDP 443 for HTTP/3. With `ufw`:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

Docker publishes container ports through its own iptables rules, which bypass `ufw`. That is why the Compose file publishes no port except Caddy's: the API (8080) and PostgreSQL (5432) are reachable only on the Compose network. Keep it that way if you edit the file. Also open the same ports in your provider's cloud firewall, if it has one.

## 4. Install Docker

Install Docker Engine and the Compose plugin from Docker's repository by following <https://docs.docker.com/engine/install/> for your distribution (the distribution's own `docker.io` package may ship an older Compose). Then let your user run Docker without `sudo` and log in again:

```bash
sudo usermod -aG docker "$USER"
```

```bash
docker compose version
```

## 5. Get the deployment files

Pick the release to install from the [releases page](https://github.com/bigbimbs/jekimo/releases) and always take the files from the same tag as the images. Replace `vX.Y.Z` below (before the first release: `main`).

```bash
sudo mkdir -p /opt/jekimo && sudo chown "$USER": /opt/jekimo && cd /opt/jekimo
```

```bash
ref=vX.Y.Z
base="https://raw.githubusercontent.com/bigbimbs/jekimo/$ref/deploy/docker-compose"
mkdir -p postgres-init
curl -fsSL -o docker-compose.yml "$base/docker-compose.yml"
curl -fsSL -o Caddyfile "$base/Caddyfile"
curl -fsSL -o .env.example "$base/.env.example"
curl -fsSL -o postgres-init/10-jekimo.sh "$base/postgres-init/10-jekimo.sh"
chmod 755 postgres-init/10-jekimo.sh
```

```bash
cp .env.example .env && chmod 600 .env
```

`.env` holds secrets. Keep it `chmod 600`, out of version control, and out of any unencrypted copy that leaves the server.

## 6. Choose a database

PostgreSQL is the only supported engine. Use version 14 or newer; the Compose file and CI run 16, and 13 is the oldest that has the built-in `gen_random_uuid()` Jekimo needs. In both options the services connect as a **restricted application account**, `jekimo`, that owns the Jekimo database and nothing else. Administrator credentials are used at most once and are not kept by the instance. The full design, including the privileges, checks, and rollback, is in [database-setup.md](database-setup.md).

### Option 1: local PostgreSQL in Compose

Use this when the VPS should run its own database. In `.env`:

```bash
COMPOSE_PROFILES=local-db
JEKIMO_DB_PASSWORD=<output of: openssl rand -hex 32>
POSTGRES_ADMIN_PASSWORD=<another output of: openssl rand -hex 32>
```

Hex passwords are needed here because `JEKIMO_DB_PASSWORD` is placed into a connection string. On the first start, with an empty `postgres-data` volume, the init script creates the `jekimo` account and database and then removes the superuser's password, so `POSTGRES_ADMIN_PASSWORD` is used once. Delete that line from `.env` after the first successful start (section 8). The database is reachable only from the Compose network; the superuser is reachable only with `docker compose exec postgres psql -U postgres` on the server.

### Option 2: an existing PostgreSQL server

Use this when you already run and back up PostgreSQL, on this VPS or elsewhere.

1. As a PostgreSQL administrator, create the account and database. Choose a long random password (`openssl rand -hex 32`):

   ```sql
   CREATE ROLE jekimo LOGIN PASSWORD '<generated password>'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   CREATE DATABASE jekimo OWNER jekimo ENCODING 'UTF8';
   REVOKE ALL ON DATABASE jekimo FROM PUBLIC;
   GRANT CONNECT ON DATABASE jekimo TO jekimo;
   \c jekimo
   REVOKE ALL ON SCHEMA public FROM PUBLIC;
   ```

   On PostgreSQL 14 or older, also run `ALTER SCHEMA public OWNER TO jekimo;` in the `jekimo` database (from 15 the database owner owns `public`). The privileges and why each is needed are in [`packages/storage-postgres/README.md`](../packages/storage-postgres/README.md#database-privileges). The account needs no superuser, `CREATEDB`, `CREATEROLE`, replication rights, extensions, or access to any other database.

2. Allow the VPS in `pg_hba.conf`, preferably with `hostssl jekimo jekimo <VPS address>/32 scram-sha-256`.
3. In `.env`, empty the profile and the local passwords, and set the connection string:

   ```bash
   COMPOSE_PROFILES=
   JEKIMO_DB_PASSWORD=
   POSTGRES_ADMIN_PASSWORD=
   JEKIMO_DATABASE_URL=postgres://jekimo:<password>@db.example.com:5432/jekimo?sslmode=verify-full
   ```

   URL-encode the password if it is not hex.

Letting Jekimo create the account with administrator credentials entered once (`jekimo-setup-db`) is designed in [database-setup.md](database-setup.md#flow-a2-existing-server-account-created-by-jekimo-with-admin-credentials-used-once-planned) but not implemented yet.

#### TLS to an existing database

Across a network, use `sslmode=verify-full`, which encrypts and checks the server's certificate and host name. For a server whose certificate comes from a private CA, put the CA certificate next to the Compose file as `db-ca.crt` and create `docker-compose.override.yml`, which Compose reads automatically:

```yaml
services:
  api:
    volumes: ["./db-ca.crt:/run/jekimo/db-ca.crt:ro"]
  worker:
    volumes: ["./db-ca.crt:/run/jekimo/db-ca.crt:ro"]
  migrate:
    volumes: ["./db-ca.crt:/run/jekimo/db-ca.crt:ro"]
```

and add `&sslrootcert=/run/jekimo/db-ca.crt` to `JEKIMO_DATABASE_URL`. The other `sslmode` values are explained in [database-setup.md](database-setup.md#tls-for-an-existing-database).

#### PostgreSQL on the VPS host itself

To reach a PostgreSQL server installed directly on the host (not in Compose), add `extra_hosts: ["host.docker.internal:host-gateway"]` to `api`, `worker`, and `migrate` in `docker-compose.override.yml`, use `host.docker.internal` as the host in `JEKIMO_DATABASE_URL`, make PostgreSQL listen on the Docker bridge address (`listen_addresses`), and allow the Docker subnet in `pg_hba.conf`. `sslmode=disable` is acceptable for this host-local connection.

## 7. Configure the environment

Set the two required values in `.env`:

| Variable | Example | Meaning |
| --- | --- | --- |
| `JEKIMO_VERSION` | `0.2.0` | Image tag for the API, worker, and migrations. Pin an exact version; never `latest` in production. |
| `JEKIMO_DOMAIN` | `jekimo.example.com` | The host name from section 2. Caddy requests its certificate. |

Everything else has a safe default. The optional settings are listed, commented out, at the bottom of `.env.example`, and every setting is described in [configuration.md](configuration.md). The Compose file passes each service only the variables it reads, so the PostgreSQL superuser password never reaches the API or worker.

Check the result before starting. This prints the resolved configuration, including secrets, so do not paste its output anywhere:

```bash
docker compose config --quiet && echo ok
```

## 8. First start

```bash
docker compose pull
docker compose up -d --wait
docker compose ps -a
```

`--wait` returns once PostgreSQL (with Option 1) and the API are healthy. Expect `migrate` to show `Exited (0)` and the others `Up`, with `api` and `postgres` `(healthy)`. The API's health check calls `GET /readyz`, which answers `200` only when the database and the queue respond. If a service restarts in a loop, see [Troubleshooting](#troubleshooting).

With Option 1, remove the superuser password from `.env` now; it has done its job:

```bash
sed -i '/^POSTGRES_ADMIN_PASSWORD=/d' .env
```

Caddy requests the certificate in the background. Check HTTPS:

```bash
curl -fsS https://jekimo.example.com/healthz
```

It prints `{"status":"ok"}`. `/readyz` is answered with `404` from outside; it is for the container runtime only.

## 9. Create the first admin and project

On the first start, with no users in the database, the API prints a one-time **setup token** to its console ([access-model.md](access-model.md#setup-flow)). Anyone with the token can take over the instance until setup is done, so do this straight away and do not paste the token anywhere else.

```bash
docker compose logs api | grep -A2 "setup token"
```

The token is the last line. It is valid until setup completes or the API restarts; a restart before setup prints a new one.

Setup creates the first **instance admin**, the first **project**, and that project's first **ingestion key** in one request. Use your own email, a password of 12 to 128 characters, and a project name. Prefix the command with a space so it stays out of your shell history (Bash and Zsh skip such lines when `HISTCONTROL=ignorespace` or `setopt HIST_IGNORE_SPACE` is set), or type it in an editor and pipe it in:

```bash
 curl -sS -X POST https://jekimo.example.com/api/v1/setup \
  -H 'content-type: application/json' \
  -d '{"setup_token":"<token>","email":"admin@example.com","password":"<12 to 128 characters>","project_name":"Billing API"}'
```

The response contains `ingestion_key.key`, in the form `jk_<key_id>_<secret>`. It is shown **once**: copy it into your secret manager now. The database keeps only its hash, and logs record only its `key_id`. After setup succeeds, `/api/v1/setup` answers `404` and the token stops working.

Sign-in, more projects, and more keys are shown in [local-development.md](local-development.md) sections 4 and 5; use `https://jekimo.example.com` in place of `http://127.0.0.1:8080`.

## 10. Send a first event

Read the key without echoing it, so it is not stored in shell history or shown on screen:

```bash
read -rs JEKIMO_KEY && export JEKIMO_KEY
```

Paste the key and press Enter. Then send one synthetic event:

```bash
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
curl -sS -i https://jekimo.example.com/api/v1/ingest \
  -H "Authorization: Bearer $JEKIMO_KEY" \
  -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "sent_at": "$now",
  "events": [
    {
      "schema_version": 1,
      "event_id": "01JC0000000000000000000000",
      "timestamp": "$now",
      "kind": "log",
      "severity": "info",
      "message": "Jekimo install check",
      "service": "install-check",
      "environment": "production",
      "attributes": { "synthetic": true }
    }
  ]
}
EOF
```

A working instance answers `HTTP/2 202` with `{"accepted":["01JC0000000000000000000000"],"rejected":[]}`. Within a few seconds the worker logs `job processed` with `"inserted":1`:

```bash
docker compose logs worker | tail -n 3
```

Sending the same request again also returns `202` but stores nothing new, because events are deduplicated by `event_id`. Clear the key when you are done:

```bash
unset JEKIMO_KEY
```

Then add an SDK to your application; for Node.js see [`@jekimo/sdk-node`](../packages/sdk-node/README.md).

## 11. Rate limits and quotas

> **Not implemented yet** ([issue #24](https://github.com/bigbimbs/jekimo/issues/24)). This section describes the specified behaviour so you can plan for it. Until it lands, the queue bound (`JEKIMO_QUEUE_MAX_DEPTH`, default 10,000 queued requests) is the only protection: when the worker falls that far behind, ingestion answers `503` with `Retry-After: 30` and SDKs back off.

Per [ingestion-protocol.md](ingestion-protocol.md#rate-limits-and-quotas), every project gets a **rate limit** in events per minute (default 1,000) and may get a **quota** in events per day or month (default none):

- The rate limit absorbs bursts; it does not cap the total. 1,000 events a minute sustained is 43 million a month, far beyond the reference VPS. Over-limit requests get `429 rate_limited` with `Retry-After`.
- The quota caps volume. To keep the reference VPS within 1,000,000 events a month, give projects daily quotas that add up to about 33,000 a day, for example 10,000 a day each for three projects. Over-quota requests get `429 quota_exceeded` until the period rolls over, and those events are dropped.
- Size from the disk, not the other way round: pick the retention you need, use the storage formula in section 1 to find how many monthly events your disk holds, and split that between projects as quotas. Keep the rate limit at or above each project's realistic peak so bursts after a deploy are not dropped.

## 12. Disk space

> **Disk monitoring is not implemented yet** ([issue #29](https://github.com/bigbimbs/jekimo/issues/29)). The levels below are specified in [retention.md](retention.md#disk-safety) and will apply once it lands. Until then, nothing stops ingestion when the disk fills, so watch free space yourself.

| Free space on the database volume | What Jekimo will do |
| --- | --- |
| Below 20% (`JEKIMO_DISK_WARN_PERCENT`) | Warning banner for instance admins and an audit log entry. |
| Below 10% (`JEKIMO_DISK_CRITICAL_PERCENT`) | Emergency expiry: expiry runs every minute and retention is treated as at most 7 days for all projects, oldest days first, until free space is back above 20%. This deletes data before its configured retention and is logged per project. |
| Below 5% (`JEKIMO_DISK_FULL_PERCENT`) | Ingestion is refused with `503` and `Retry-After: 60`; SDKs retry, then drop. Querying and export keep working so data can be moved out. |

Size the disk so you never reach 10% in normal operation. To watch it:

```bash
df -h /var/lib/docker
docker system df
docker compose exec postgres psql -U jekimo -d jekimo -c "SELECT pg_size_pretty(pg_database_size('jekimo'))"
```

(The last command is for Option 1; with Option 2, run the query on your server.) A simple alert is a daily cron job that mails or posts when `df --output=pcent /var/lib/docker` passes 80%. To free space: lower retention or set quotas on the largest projects, move backups off the server, and remove unused images with `docker image prune`.

## 13. Backups

Follow [backups-and-restore.md](backups-and-restore.md): a nightly `pg_dump` from the `postgres` service (Option 1) or your own database backups (Option 2), copied off the server every day, with a monthly restore drill. A backup on the VPS's own disk does not survive losing the VPS.

Also keep a private copy of `.env` (it holds the database password) and of `docker-compose.override.yml` if you have one. Caddy's certificates in the `caddy-data` volume need no backup; Caddy gets new ones.

## 14. Upgrades

Read the release notes for every version between yours and the target, especially **Breaking** entries. In `0.x`, a minor version may contain breaking changes ([releasing.md](releasing.md#versioning-policy)).

1. Take a backup and check it ([backups-and-restore.md](backups-and-restore.md#take-a-backup)).
2. Download the deployment files from the new tag into a scratch directory (section 5) and compare them with yours, for example `diff -u docker-compose.yml new/docker-compose.yml`. Take over the new files, keeping your `.env` and override file, and add any new required variable to `.env`.
3. Set `JEKIMO_VERSION` in `.env` to the new version.
4. Pull the images, apply migrations, and restart:

   ```bash
   docker compose pull
   docker compose run --rm migrate
   docker compose up -d --wait
   docker compose ps -a
   ```

5. Send a test event (section 10).

While the API restarts, SDKs get connection errors or `503` and retry with backoff, so a short upgrade loses no events that SDKs still hold in their buffers.

### Rolling back

Migrations only move forward. To return to the previous version, restore the backup from step 1 into a fresh database ([backups-and-restore.md](backups-and-restore.md#restore-into-a-fresh-database)), set `JEKIMO_VERSION` back, and run `docker compose up -d --wait`. Events received after that backup are lost. If the release notes say the new version added no migration, setting `JEKIMO_VERSION` back is enough.

## 15. Rotating credentials

- **Database password:** see [database-setup.md](database-setup.md#runtime-account-password). With Option 1:

  ```bash
  new="$(openssl rand -hex 32)"
  docker compose exec -T postgres psql -U postgres -v pw="$new" <<'SQL'
  ALTER ROLE jekimo PASSWORD :'pw';
  SQL
  sed -i "s/^JEKIMO_DB_PASSWORD=.*/JEKIMO_DB_PASSWORD=$new/" .env
  unset new
  docker compose up -d --wait
  ```

- **Ingestion keys:** create a new key for the project (`POST /api/v1/projects/<id>/keys`, see [local-development.md](local-development.md)), deploy it to your applications, then stop using the old one. Endpoints to rotate and revoke keys are not implemented yet ([issue #21](https://github.com/bigbimbs/jekimo/issues/21)), so an old key keeps working until then; treat a leaked key as an incident and watch its project for unexpected events.
- **Admin password:** password reset is not implemented yet ([issue #19](https://github.com/bigbimbs/jekimo/issues/19)). Keep the instance admin's password in a password manager.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `docker compose` says `required variable JEKIMO_VERSION is missing a value` (or `JEKIMO_DOMAIN`) | Set it in `.env`, next to `docker-compose.yml`. Run commands from `/opt/jekimo`. |
| `depends_on ... required` is rejected | Docker Compose is older than 2.20. Install the plugin from Docker's repository (section 4). |
| Caddy cannot get a certificate | DNS does not point at this VPS yet, or ports 80 and 443 are blocked by `ufw` or the provider's firewall. Check `docker compose logs caddy`. Let's Encrypt rate-limits repeated failures, so fix DNS before retrying. |
| `502 Bad Gateway` | The API is not running or not healthy. Check `docker compose ps -a` and `docker compose logs api`. |
| `migrate` exits with an error and `api` and `worker` do not start | Read `docker compose logs migrate`. Usually a wrong `JEKIMO_DATABASE_URL`, a TLS error, or missing privileges. Fix it and run `docker compose up -d --wait` again. |
| `postgres` stops on the first start with `JEKIMO_DB_PASSWORD is not set` or a password error | `.env` was incomplete when the volume was initialised. Fix `.env`, remove the half-initialised volume with `docker compose down -v` (only on a new installation: this deletes the database), and start again. |
| `password authentication failed for user "jekimo"` | `JEKIMO_DB_PASSWORD` changed after the volume was initialised. Set the password in the database (section 15) or put back the old one. |
| `permission denied for schema public` | The account does not own the database or its `public` schema. Re-run the SQL in Option 2. |
| TLS error connecting to an existing database | `sslmode=verify-full` needs a CA the container trusts and a host name that matches the certificate. Mount the CA (section 6) or connect by the name on the certificate. |
| `api` unhealthy, logs show `readiness check failed` | The API cannot reach the database. Check `postgres` is healthy, or that the external server accepts connections from the VPS. |
| Setup token not in the log | Setup already finished (`/api/v1/setup` answers `404`), or the log was rotated. While no user exists, `docker compose restart api` prints a new token. |
| Ingest returns `401 unauthorized` | Wrong or truncated key. Keys look like `jk_` + 12 characters + `_` + 32 characters. |
| Ingest returns `415 unsupported_media_type` | Missing `Content-Type: application/json`, or a content encoding other than `gzip`. |
| Ingest returns `202` with the event in `rejected` | The payload is invalid; the `errors` array names the field. Check that `timestamp` is not more than 5 minutes ahead of `sent_at` and that `event_id` is a valid ULID. |
| Ingest returns `503 unavailable` | The queue is full (the worker is down or far behind) or the database is unreachable. Check `docker compose logs worker` and `docker compose ps`. |
| Events accepted but never stored | The worker is not running or failing. Check `docker compose logs worker`. |
| The disk is filling | See section 12. |

To report a problem, open an issue with the Jekimo version, `docker compose ps -a`, and the relevant log lines with keys, passwords, tokens, and event payloads removed. Report security problems privately as described in [SECURITY.md](../SECURITY.md).
