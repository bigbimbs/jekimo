# Install on a VPS

This guide installs one Jekimo instance on one Linux VPS with Docker Compose, behind Caddy for HTTPS, using either an existing PostgreSQL database or one provisioned on the same machine.

> **Status: first draft, not usable yet.** Jekimo has not been released and the services, images, and Compose file do not exist yet. This guide is written against the specs in this directory so the first release ships with a reviewed install path. Every file name, command, or default that depends on code still being written is marked **To confirm when the slice lands**. Do not follow this guide on a server you care about until those notes are gone.

## Overview

```text
Internet ──443──> Caddy (HTTPS, on the host)
                    │
                    └──> 127.0.0.1:8080 ──> Jekimo API + dashboard ──> durable queue ──> worker
                                                   │                                     │
                                                   └──────────── PostgreSQL ─────────────┘
                                                        (existing, or local in Compose)
```

- The **API** serves the ingestion endpoint (`POST /api/v1/ingest`), the query API, and the web dashboard.
- The **worker** validates, redacts, fingerprints, stores, and expires events.
- **PostgreSQL** holds everything: metadata and events. It is either a server you already run or a container in the same Compose project.
- **Caddy** terminates TLS and is the only thing listening on public ports.

## 1. Prerequisites

### Server

| Resource | Reference size | Notes |
| --- | --- | --- |
| CPU | 2 vCPU | `linux/amd64` or `linux/arm64`; images are published for both. |
| Memory | 4 GB | Includes PostgreSQL on the same host. |
| Disk | 80 GB SSD | See the storage formula below. SSD, not network-attached spinning disk. |
| OS | A current Linux distribution with Docker support | Examples below use Debian or Ubuntu. |

This reference VPS is sized for **1,000,000 accepted events a month across all projects at 30-day retention**, with bursts of 1,000 events a minute per project ([retention.md](retention.md)). These targets are proposals and will be confirmed by measurement before the first release.

### Storage formula

Estimate the disk that events need with:

```text
event storage = monthly events × average event size × (retention days ÷ 30) × 2
```

The average stored event is about **4 KiB** including indexes, and the factor of 2 is a safety margin for PostgreSQL overhead, bloat between vacuums, and growth. Add the operating system, Docker images (a few GB), and local backups on top.

| Monthly events | Retention | Event storage (with safety factor) |
| --- | --- | --- |
| 1,000,000 | 30 days | about 8 GB |
| 1,000,000 | 90 days | about 23 GB |
| 3,000,000 | 14 days | about 11 GB |
| 5,000,000 | 30 days | about 39 GB |

Local backups are compressed dumps of the whole database and are kept for 14 days by default ([object-storage.md](object-storage.md)); budget at least the size of three or four dumps on the backup volume, or configure object storage so backups leave the VPS.

### What happens when the disk fills

Jekimo watches free space on the database volume ([retention.md](retention.md)). Point `JEKIMO_DISK_PATH` at that volume in the API and worker containers (mount it read-only), or, when PostgreSQL runs elsewhere, set `JEKIMO_DISK_BUDGET_BYTES` to the database size you allow ([configuration.md](configuration.md#disk-safety)). If free space cannot be read, ingestion is refused rather than risk the database.

| Free space | What Jekimo does |
| --- | --- |
| Below 20% | Warning banner for instance admins. |
| Below 10% | Emergency expiry: retention is temporarily treated as at most 7 days for all projects, oldest days first, until free space is back above 20%. This deletes data before its configured retention. |
| Below 5% | Ingestion is refused with `503` and `Retry-After: 60`. SDKs retry, then drop. The dashboard and exports keep working. |

Size the disk so you never reach 10% in normal operation, and set per-project quotas (section 8) so one noisy project cannot push you there.

### Software and accounts

- A domain name you control, with the ability to create DNS records.
- Docker Engine with the Compose plugin (`docker compose version` prints v2 or newer).
- Caddy 2.
- SSH access with `sudo`.

### Network

Allow inbound TCP 22 (SSH), 80 (HTTP, for certificate issuance and redirects), and 443 (HTTPS). Do not expose PostgreSQL or the Jekimo port (8080) publicly. With `ufw`:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Docker publishes container ports through its own iptables rules, which bypass `ufw`. The Compose file binds Jekimo to `127.0.0.1` only for this reason; keep it that way if you edit it.

## 2. DNS

Create an `A` record (and an `AAAA` record if the VPS has IPv6) for the name operators and SDKs will use, for example `jekimo.example.com`, pointing at the VPS. Wait until it resolves:

```bash
dig +short jekimo.example.com
```

This hostname becomes the instance `base_url` (`https://jekimo.example.com`). SDKs send events to `https://jekimo.example.com/api/v1/ingest`.

## 3. Install Docker and Caddy

Install Docker Engine and the Compose plugin by following Docker's instructions for your distribution: <https://docs.docker.com/engine/install/>.

Install Caddy from its official package repository: <https://caddyserver.com/docs/install#debian-ubuntu-raspbian>.

## 4. Get the deployment files

```bash
sudo mkdir -p /opt/jekimo
sudo chown "$USER" /opt/jekimo
cd /opt/jekimo
curl -fsSLO https://raw.githubusercontent.com/bigbimbs/jekimo/vX.Y.Z/deploy/docker-compose/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/bigbimbs/jekimo/vX.Y.Z/deploy/docker-compose/.env.example
cp .env.example .env
chmod 600 .env
```

Replace `vX.Y.Z` with the release you are installing, from the [releases page](https://github.com/bigbimbs/jekimo/releases). Always take the Compose file from the same tag as the images.

> **To confirm when the slice lands:** the Compose file name `deploy/docker-compose/docker-compose.yml`, the presence of `deploy/docker-compose/.env.example`, and the published port `127.0.0.1:8080`. The repository currently only has `docker-compose.dev.yml` planned for local development.

## 5. Choose a database path

Jekimo supports PostgreSQL only in the first release. Pick one of two paths. In both, the running services connect with a **dedicated, restricted application account**; administrator credentials are used once during setup, if at all, and are never stored ([access-model.md](access-model.md), [architecture.md](architecture.md)).

> **To confirm when the slice lands:** the supported PostgreSQL major versions. Plan for PostgreSQL 16 or newer.

### Path A: connect an existing PostgreSQL server

Use this when you already run PostgreSQL, on this VPS or elsewhere, and back it up yourself.

1. As a PostgreSQL administrator, create the application role and database. Choose a long random password (for example `openssl rand -base64 32`) and keep it out of shell history:

   ```sql
   CREATE ROLE jekimo LOGIN PASSWORD '<generated password>'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
   CREATE DATABASE jekimo OWNER jekimo ENCODING 'UTF8';
   \c jekimo
   REVOKE ALL ON SCHEMA public FROM PUBLIC;
   GRANT ALL ON SCHEMA public TO jekimo;
   ```

2. Required privileges: the application role owns the `jekimo` database and its schema, so it can run migrations and create and drop the daily event partitions that retention relies on. It needs **no** superuser, `CREATEDB`, `CREATEROLE`, or replication rights, and no access to any other database.
3. Allow the VPS to connect in `pg_hba.conf`, preferably with `hostssl ... scram-sha-256` so only TLS connections with SCRAM passwords are accepted.
4. TLS: when the database is on another host, require TLS and verify the server certificate. Use `sslmode=verify-full` and, for a private CA, mount the CA certificate into the containers and point `sslrootcert` at it. `sslmode=require` encrypts but does not verify the server and is only acceptable on a private network you trust. A database on the same VPS reached over a Unix socket or `127.0.0.1` may use `sslmode=disable`.
5. Build the connection string for `.env` (section 6):

   ```text
   postgres://jekimo:<url-encoded password>@db.internal.example.com:5432/jekimo?sslmode=verify-full&sslrootcert=/run/secrets/db-ca.crt
   ```

To reach a PostgreSQL server running on the VPS host itself from inside Compose, use `host.docker.internal` (the Compose file maps it to the host gateway) and make PostgreSQL listen on the Docker bridge address as well as `127.0.0.1`.

> **To confirm when the slice lands:** whether setup also accepts administrator credentials once to create the role and database for you on an existing server, as the README describes, how the CA certificate is mounted, and the `host.docker.internal` mapping.

### Path B: provision PostgreSQL locally

Use this when the VPS should run its own database. The Compose file includes a PostgreSQL service with a named volume; setup creates the `jekimo` database and the restricted application account and the services use only that account afterwards.

Enable it in `.env`:

```bash
COMPOSE_PROFILES=local-db
```

The local database listens only on the Compose network, never on a host port. Its data lives in the `jekimo-postgres` Docker volume; back it up as described in section 10.

> **To confirm when the slice lands:** the Compose profile name `local-db`, the volume name `jekimo-postgres`, and how the generated application password is stored.

## 6. Configure the environment

Edit `/opt/jekimo/.env`. It holds secrets: keep it `chmod 600`, owned by the deploying user, and out of version control and backups that leave the server unencrypted.

### Required

| Variable | Example | Meaning |
| --- | --- | --- |
| `JEKIMO_VERSION` | `0.2.0` | Image tag to run for `ghcr.io/bigbimbs/jekimo-api` and `ghcr.io/bigbimbs/jekimo-worker`. Pin an exact version; do not use `latest` or `edge` in production. |
| `JEKIMO_PUBLIC_URL` | `https://jekimo.example.com` | The instance `base_url`. Used for links and secure cookies. |
| `JEKIMO_DATABASE_URL` | see Path A | Connection string for the application account. Leave unset with Path B. |

`JEKIMO_DATABASE_URL` is implemented ([configuration.md](configuration.md#database)); the older name `DATABASE_URL` is still read when it is unset but is deprecated.

> **To confirm when the slice lands:** the names `JEKIMO_VERSION` and `JEKIMO_PUBLIC_URL`. They are not yet in a spec; the variables below are.

### Optional, from the specs

All have safe defaults. Change them only when you need to.

| Variable | Default | Meaning | Spec |
| --- | --- | --- | --- |
| `JEKIMO_RETENTION_DEFAULT_DAYS` | `30` | Retention for new projects | [retention.md](retention.md) |
| `JEKIMO_RETENTION_MAX_DAYS` | `3650` | Upper bound project admins can set | [retention.md](retention.md) |
| `JEKIMO_DISK_WARN_PERCENT` | `20` | Free space warning level | [retention.md](retention.md) |
| `JEKIMO_DISK_CRITICAL_PERCENT` | `10` | Emergency expiry level | [retention.md](retention.md) |
| `JEKIMO_DISK_FULL_PERCENT` | `5` | Ingestion refusal level | [retention.md](retention.md) |
| `JEKIMO_DISK_PATH` | `/` | A path on the database volume, as the API and worker see it | [configuration.md](configuration.md#disk-safety) |
| `JEKIMO_DISK_BUDGET_BYTES` | unset | Database size budget, for remote PostgreSQL | [configuration.md](configuration.md#disk-safety) |
| `JEKIMO_RATE_LIMIT_PER_MINUTE` | `1000` | Default events per minute per project | [ingestion-protocol.md](ingestion-protocol.md) |
| `JEKIMO_QUOTA_EVENTS_PER_DAY` | unset | Default events per project per UTC day | [retention.md](retention.md) |
| `JEKIMO_AUDIT_LOG_DAYS` | `365` | Audit log retention | [retention.md](retention.md) |
| `JEKIMO_MEMBERS_CAN_CREATE_PROJECTS` | `true` | Whether instance members may create projects | [access-model.md](access-model.md) |
| `JEKIMO_SESSION_IDLE_DAYS` | `14` | Session idle timeout | [access-model.md](access-model.md) |
| `JEKIMO_SESSION_MAX_DAYS` | `30` | Session absolute lifetime | [access-model.md](access-model.md) |
| `JEKIMO_INVITE_EXPIRY_DAYS` | `7` | Invitation and reset link lifetime | [access-model.md](access-model.md) |
| `JEKIMO_SMTP_URL` | unset | When set, invitations and resets are emailed | [access-model.md](access-model.md) |
| `JEKIMO_OBJECT_STORE_URL` and related | unset | Optional cold tier, bucket backups, and exports (Phase 2) | [object-storage.md](object-storage.md) |

[configuration.md](configuration.md) is the index of every setting as they are implemented.

## 7. Start the stack and put Caddy in front

Pull the images and start the services:

```bash
cd /opt/jekimo
docker compose pull
docker compose up -d
docker compose ps
```

Every service should become `healthy` within a minute. If one restarts in a loop, see [Troubleshooting](#troubleshooting).

Configure Caddy. Replace `/etc/caddy/Caddyfile` with:

```caddyfile
jekimo.example.com {
	encode zstd gzip

	# Ingestion bodies are limited to 1 MiB by the protocol; leave headroom.
	request_body {
		max_size 2MB
	}

	reverse_proxy 127.0.0.1:8080
}
```

Reload it:

```bash
sudo systemctl reload caddy
```

Caddy obtains and renews a certificate from Let's Encrypt automatically once DNS resolves to the VPS and ports 80 and 443 are reachable. Jekimo requires HTTPS: session cookies are `Secure`, and SDKs must not send ingestion keys over plain HTTP ([ingestion-protocol.md](ingestion-protocol.md)).

Check that HTTPS works:

```bash
curl -sSI https://jekimo.example.com/ | head -n 1
```

> **To confirm when the slice lands:** the health check, the root path response, and whether the API needs a trusted-proxy setting to read client IPs from Caddy's `X-Forwarded-For` header (used for per-IP limits and the audit log).

## 8. First-run setup

The first start opens a one-time setup page protected by a token that is printed to the API's log ([access-model.md](access-model.md)).

1. Read the token from the log:

   ```bash
   docker compose logs api | grep -i "setup token"
   ```

2. Open `https://jekimo.example.com/setup` and enter the token. Anyone with the token can take over the instance until setup finishes, so do this straight away and do not paste the token anywhere else.
3. Create the first **instance admin**: your email and a password of 12 to 128 characters. There is no public sign-up; everyone else is invited later.
4. Confirm the **database option** you prepared in section 5. Jekimo checks connectivity and privileges and stops with a clear message, without leaving a half-provisioned database, if something is wrong. Any administrator credentials entered here are discarded once setup completes.
5. Create the **first project**, for example `billing-api`. Jekimo shows its first **ingestion key** once, in the form `jk_<key_id>_<secret>`. Copy it into your secret manager now; it cannot be shown again. If you lose it, rotate the key from the project's settings.

After setup the token stops working and `/setup` is closed.

> **To confirm when the slice lands:** the log line wording, the `/setup` path, and what happens to the token if the API restarts before setup finishes.

### Invite people and size limits

- Invite users from the instance admin area. Without SMTP, Jekimo gives you a single-use link to hand over; it expires after 7 days.
- Every project starts with a rate limit of 1,000 events a minute and no quota. The rate limit absorbs bursts; it does not cap the total (1,000 a minute sustained would be 43 million events a month). To keep the reference VPS within its 1,000,000 events a month, give each project an `events_per_day` quota that adds up to your budget, for example 20,000 a day each for a handful of projects. Over-quota requests get `429 quota_exceeded` until midnight UTC ([retention.md](retention.md)).
- Size the rate limit to what the worker can store: the sum of all projects' limits should stay below the worker's measured throughput (`npm run bench -w @jekimo/worker`), so a burst from every project at once drains instead of filling the queue. Size quotas from the storage formula above: `events_per_day × 30 × 4 KiB × (retention days ÷ 30)` per project, with a safety factor of 2, must fit the disk below the 20% warning level.
- Set the instance defaults with `JEKIMO_RATE_LIMIT_PER_MINUTE` and `JEKIMO_QUOTA_EVENTS_PER_DAY`, and one project's limits, as an instance admin, with `PUT /api/v1/projects/<id>/limits` and `{"rate_limit_per_minute": 2000, "events_per_day": 20000}` (`null` inherits the default). There is no dashboard screen for this yet.
- An instance admin who loses their password resets it on the VPS: `docker compose exec api jekimo admin reset-password <email>` prints a reset link. **To confirm when the slice lands:** the CLI's location inside the image.

## 9. Verify ingestion

Send one synthetic log event with `curl`. Read the key without echoing it, so it does not end up in your shell history or on screen:

```bash
read -rs JEKIMO_KEY && export JEKIMO_KEY
```

Paste the ingestion key and press Enter. Then send the event:

```bash
curl -sS -i https://jekimo.example.com/api/v1/ingest \
  -H "Authorization: Bearer $JEKIMO_KEY" \
  -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "sent_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "events": [
    {
      "schema_version": 1,
      "event_id": "01JC0000000000000000000000",
      "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
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

A working instance answers `HTTP/2 202` with:

```json
{ "accepted": ["01JC0000000000000000000000"], "rejected": [] }
```

Open the project in the dashboard; the event appears within a few seconds once the worker has processed it. Sending the same request again also returns `202` but stores nothing new, because events are deduplicated by `event_id`.

Clear the key from your shell when you are done:

```bash
unset JEKIMO_KEY
```

Then install an SDK in your application; for Node.js see [`@jekimo/sdk-node`](../packages/sdk-node/README.md).

## 10. Backups

Read [backups-and-restore.md](backups-and-restore.md) for what a backup contains. In short: a nightly compressed logical dump of the whole PostgreSQL database plus a manifest. Backups contain event data and password and key hashes, never plaintext secrets, and must be stored privately.

- **Without object storage**, dumps are written to the local backup directory on the VPS. A backup on the same disk does not survive losing the VPS: copy the directory off the server every day, for example with `rsync` or `restic` to another machine or provider.
- **With object storage** (Phase 2), dumps go to the bucket under `v1/backups/`, keeping 14 daily and 6 monthly dumps by default ([object-storage.md](object-storage.md)). Make the bucket private, enable versioning or provider-side backup, and remember that archived event days live only in the bucket.
- **Path A** (existing PostgreSQL): your existing database backups also cover Jekimo. Jekimo's own dump is still useful because its manifest records the Jekimo version and migration level.

Run a restore drill every month: restore the latest dump into a scratch database, run the integrity check, and throw the scratch database away.

> **To confirm when the slice lands:** the local backup directory and volume, the backup schedule setting, and the restore and integrity-check commands. Until Jekimo's backup job exists, a manual dump of a Path B database is:
>
> ```bash
> docker compose exec -T postgres pg_dump -U jekimo -Fc jekimo > "jekimo-$(date -u +%Y%m%d).dump"
> ```

## 11. Upgrades

Read the release notes for every version between yours and the target, especially **Breaking** entries and required migrations. Releases follow SemVer; in `0.x`, a minor version may contain breaking changes ([releasing.md](releasing.md)).

1. Take a backup and confirm it completed.
2. Fetch the Compose file from the new tag (section 4) and compare it with yours.
3. Set `JEKIMO_VERSION` in `.env` to the new version.
4. Pull the new images and run the database migrations:

   ```bash
   docker compose pull
   docker compose run --rm api node dist/migrate.mjs
   ```

   Alternatively, set `JEKIMO_MIGRATE_ON_START=true` and the API and worker apply pending migrations when they start; concurrent starts wait for each other.

5. Restart the services on the new version:

   ```bash
   docker compose up -d
   docker compose ps
   ```

6. Verify ingestion (section 9) and open the dashboard.

While the services restart, SDKs receive connection errors or `503` and retry with backoff, so a short upgrade loses no events that SDKs still hold in their buffers.

### Rolling back

Migrations move forward only. To go back to the previous version:

1. Stop the services: `docker compose down` (this keeps volumes).
2. Restore the backup taken in step 1 into the database ([backups-and-restore.md](backups-and-restore.md)). Events received since that backup are lost.
3. Set `JEKIMO_VERSION` back to the previous version and run `docker compose up -d`.

If the new version did not run any migration (the release notes say so), step 2 can be skipped.

> **To confirm when the slice lands:** whether the API refuses to start against an unmigrated database, and whether migrations are ever reversible.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Caddy cannot get a certificate | DNS does not point at this VPS yet, or ports 80 and 443 are blocked by `ufw` or the provider's firewall. Check `journalctl -u caddy`. |
| `502 Bad Gateway` from Caddy | The Jekimo container is not running or not listening on `127.0.0.1:8080`. Check `docker compose ps` and `docker compose logs api`. |
| A service restarts in a loop | Read `docker compose logs <service>`. Usually a missing required variable in `.env` or a database connection error. |
| Database connection fails with a TLS error | `sslmode=verify-full` needs the server's CA and a hostname that matches its certificate. Mount the CA and set `sslrootcert`, or connect by the name on the certificate. |
| `permission denied for schema public` | The application role does not own the database or schema. Re-run the grants in Path A. |
| Setup token not in the log | Setup is already finished, or the log was rotated. **To confirm when the slice lands:** how to issue a new token. |
| Ingest returns `401 unauthorized` | Wrong, revoked, or truncated key. Keys look like `jk_` + 12 characters + `_` + 32 characters. Rotate it if unsure. |
| Ingest returns `415 unsupported_media_type` | The request is missing `Content-Type: application/json` or uses an encoding other than `gzip`. |
| Ingest returns `202` with the event in `rejected` | The payload is invalid; the `errors` array names the field. Check `timestamp` is not more than 5 minutes in the future and `event_id` is a valid ULID. |
| Ingest returns `429` | `rate_limited`: the project exceeded its per-minute limit, retry after `Retry-After`. `quota_exceeded`: the daily quota is used up until midnight UTC. |
| Ingest returns `503 unavailable` | The disk is below the full threshold or the queue or database is down. Check `df -h`, the admin banner, and the worker logs. Free space or grow the disk; lower retention for large projects. |
| Events accepted but not visible | The worker is not running or is behind. Check `docker compose logs worker`. |
| The VPS is running out of disk | See "What happens when the disk fills". Lower retention or set quotas on the largest projects, move backups off the VPS, and prune unused images with `docker image prune`. |
| Locked out of the admin account | After 10 failed sign-ins in 15 minutes, sign-in is blocked for 15 minutes. Use the reset command in section 8. |

To report a problem, open an issue with the Jekimo version, `docker compose ps` output, and the relevant log lines with keys, passwords, and event payloads removed. Report security problems privately as described in [SECURITY.md](../SECURITY.md).
