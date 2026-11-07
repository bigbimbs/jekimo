# Configuration

Every runtime setting is an environment variable. Never include real credentials in examples; [`.env.example`](../.env.example) at the repository root has safe placeholders for local development, [`deploy/docker-compose/.env.example`](../deploy/docker-compose/.env.example) is the template for a production install, and local `.env` files stay out of version control.

This page lists every setting: its default, the values it accepts, which service reads it, what it does, the spec that defines it, and its status. **Implemented** means the code reads it today; **planned** means a spec defines it but no code reads it yet. The status changes to implemented as each setting lands.

Unless a row says otherwise, an invalid value stops the service at start-up with a message naming the variable, never echoing its value. An empty value is the same as unset. Booleans accept `true`, `false`, `1`, or `0`. All Jekimo variables are prefixed `JEKIMO_`, except the deprecated `DATABASE_URL` and the Compose-only variables at the end.

Services: **API** is `apps/api`, **worker** is `apps/worker`, **migrate** is `npm run migrate` and the Compose `migrate` service (`node dist/migrate.mjs`).

## Database

| Variable | Default | Valid values | Read by | Meaning | Spec | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `JEKIMO_DATABASE_URL` | required | A PostgreSQL connection string, for example `postgres://jekimo:<password>@db.example.com:5432/jekimo?sslmode=verify-full`. TLS parameters as in [database-setup.md](database-setup.md#tls-for-an-existing-database). | API, worker, migrate | Connection for the restricted runtime account. Never logged. | [database-setup.md](database-setup.md) | implemented |
| `DATABASE_URL` | unset | As above | API, worker, migrate | **Deprecated.** Read only when `JEKIMO_DATABASE_URL` is unset, with a deprecation warning. It will be removed in a later release; rename it. | — | implemented |
| `JEKIMO_DATABASE_POOL_MAX` | `10` | Positive integer. Any other value falls back to `10` without an error. | API, worker, migrate | Maximum database connections per process. | — | implemented |
| `JEKIMO_MIGRATE_ON_START` | `false` | Boolean | API, worker | When `true`, apply pending migrations and create the coming week's event partitions before serving. Concurrent starts wait for each other on an advisory lock. Leave it `false` when migrations run as a separate step (`npm run migrate` or the Compose `migrate` service). | — | implemented |
| `JEKIMO_MIGRATIONS_DIR` | the `migrations/` directory of `packages/storage-postgres` | A directory path | API, worker, migrate | Where the migration runner reads `NNNN_description.sql` files. The images set `/app/migrations`. | — | implemented |

The privileges the runtime account needs are in [`packages/storage-postgres/README.md`](../packages/storage-postgres/README.md#database-privileges). The first release uses one account for migrations and runtime; how setup creates it and keeps administrator credentials out of the instance is in [database-setup.md](database-setup.md).

## API server

| Variable | Default | Valid values | Read by | Meaning | Spec | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `JEKIMO_API_HOST` | `127.0.0.1` | A listen address | API | Listen address. The API image sets `0.0.0.0`. | — | implemented |
| `JEKIMO_API_PORT` | `8080` | Integer, 1 to 65535 | API | Listen port. | — | implemented |
| `JEKIMO_LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, or `trace`, in lower case | API, worker | Log level. Logs are JSON and never contain ingestion keys, passwords, session tokens, or event payloads. | — | implemented |
| `JEKIMO_TRUST_PROXY` | `false` | Boolean | API | Trust `X-Forwarded-For` from a reverse proxy when recording the client address. Enable only behind a proxy you control; the production Compose file sets `true` because Caddy is the API's only client. | — | implemented |

The API serves plain HTTP. In production it runs behind a TLS-terminating reverse proxy ([install-vps.md](install-vps.md)); session cookies are always `Secure`. Plain HTTP is acceptable only on the loopback interface for local development.

## Access and sessions

| Variable | Default | Valid values | Read by | Meaning | Spec | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `JEKIMO_MEMBERS_CAN_CREATE_PROJECTS` | `true` | Boolean | API | Whether instance members may create projects | [access-model.md](access-model.md#planned-configuration) | implemented |
| `JEKIMO_SESSION_IDLE_DAYS` | `14` | Integer, 1 to `JEKIMO_SESSION_MAX_DAYS` | API | Session idle timeout | [access-model.md](access-model.md#planned-configuration) | implemented |
| `JEKIMO_SESSION_MAX_DAYS` | `30` | Integer, 1 to 365 | API | Session absolute lifetime | [access-model.md](access-model.md#planned-configuration) | implemented |
| `JEKIMO_INVITE_EXPIRY_DAYS` | `7` | Integer, 1 to 90 | API | Invitation and reset link lifetime | [access-model.md](access-model.md#planned-configuration) | implemented |
| `JEKIMO_PUBLIC_URL` | unset | An `http` or `https` URL without credentials, query, or fragment | API | Address the dashboard is served on, used to build invitation and reset links. Unset, the links are paths such as `/invite#token=...`. The production Compose file defaults it to `https://$JEKIMO_DOMAIN`. | — | implemented |
| `JEKIMO_SMTP_URL` | unset | An SMTP URL | API | When set, invitations and resets are emailed | [access-model.md](access-model.md#planned-configuration) | planned |

## Ingestion

| Variable | Default | Valid values | Read by | Meaning | Spec | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Rate limit (name not decided) | 1,000 events per minute per project | Positive integer | API | Instance-wide default for each project's rate limit; over-limit requests get `429 rate_limited` | [ingestion-protocol.md](ingestion-protocol.md#rate-limits-and-quotas) | planned |
| Quota (name not decided) | no quota | Events per day or month | API | Instance-wide default for each project's quota; over-quota requests get `429 quota_exceeded` until the period rolls over | [ingestion-protocol.md](ingestion-protocol.md#rate-limits-and-quotas) | planned |
| `JEKIMO_QUEUE_MAX_DEPTH` | `10000` | Positive integer. Any other value falls back to the default without an error. | API | Pending and running ingest jobs (one per accepted request) the queue holds. When it is full, `POST /api/v1/ingest` returns `503 unavailable` with `Retry-After: 30`. Dead-lettered jobs do not count. Concurrent requests can overshoot it by a few jobs. | — | implemented |
| `JEKIMO_KEY_ROTATION_GRACE_HOURS` | `24` | Integer, 0 to 720 | API | How long a rotated ingestion key keeps working. A rotation request can set its own `grace_hours`. | [ingestion-protocol.md](ingestion-protocol.md#rules) | implemented |
| `JEKIMO_QUEUE_MAX_ATTEMPTS` | `5` | Positive integer. Any other value falls back to the default without an error. | API | Attempts before a queued ingest job is dead-lettered. Stamped on each job at enqueue time. | — | implemented |

The rate limit and quota variable names are not decided yet; the spec fixes only the defaults. How to size them for a VPS is in [install-vps.md](install-vps.md#11-rate-limits-and-quotas).

## Queue and worker

| Variable | Default | Valid values | Read by | Meaning | Spec | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `JEKIMO_QUEUE_VISIBILITY_SECONDS` | `60` | Positive integer. Any other value falls back to the default without an error. | worker | How long a claimed job is hidden from other workers before it is redelivered. | — | implemented |
| `JEKIMO_WORKER_BATCH_SIZE` | `10` | Integer, 1 to 100 | worker | Jobs claimed per poll. Each job is one ingest request of up to 100 events. | — | implemented |
| `JEKIMO_WORKER_POLL_MS` | `1000` | Integer, 50 to 60000 | worker | Wait between polls when the queue is empty. | — | implemented |
| `JEKIMO_EXPIRY_INTERVAL_MINUTES` | `15` | Integer, 1 to 15 | worker | Interval of the expiry pass. | [retention.md](retention.md#expiry-mechanics) requires at least every 15 minutes | implemented |

Dead-lettered jobs stay in the `queue_jobs` table with `status = 'dead'` and a payload-free `last_error` for inspection. `PostgresQueue.stats()` reports queue depth, the age of the oldest pending or running job, and the dead-lettered count.

## Retention and disk safety

| Variable | Default | Valid values | Read by | Meaning | Spec | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `JEKIMO_RETENTION_DEFAULT_DAYS` | `30` | Integer, 1 to `JEKIMO_RETENTION_MAX_DAYS` | API | Retention for new projects | [retention.md](retention.md#planned-configuration) | implemented |
| `JEKIMO_RETENTION_MAX_DAYS` | `3650` | Integer, 1 to 3650 | API | Upper bound project admins can set | [retention.md](retention.md#planned-configuration) | implemented |
| `JEKIMO_DISK_WARN_PERCENT` | `20` | Percentage | — | Free space warning level | [retention.md](retention.md#planned-configuration) | planned |
| `JEKIMO_DISK_CRITICAL_PERCENT` | `10` | Percentage | — | Emergency expiry level | [retention.md](retention.md#planned-configuration) | planned |
| `JEKIMO_DISK_FULL_PERCENT` | `5` | Percentage | — | Ingestion refusal level | [retention.md](retention.md#planned-configuration) | planned |
| `JEKIMO_AUDIT_LOG_DAYS` | `365` | Integer, 1 to 3650 | worker | Audit log retention. The expiry pass deletes older entries, including those about deleted projects. | [retention.md](retention.md#planned-configuration) | implemented |

What happens at each disk level is in [retention.md](retention.md#disk-safety) and [install-vps.md](install-vps.md#12-disk-space).

## Object storage

Object storage is Phase 2: none of these settings is read in the first release. They are listed so operators can plan for them.

| Variable | Default | Valid values | Read by | Meaning | Spec | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `JEKIMO_OBJECT_STORE_URL` | unset | `s3://bucket/prefix` or `file:///path` | — | Unset disables the cold tier, bucket backups, and bucket exports. | [object-storage.md](object-storage.md#planned-configuration) | planned |
| `JEKIMO_OBJECT_STORE_ENDPOINT` | provider default | An HTTPS URL | — | S3 endpoint, for example the R2 account endpoint | [object-storage.md](object-storage.md#planned-configuration) | planned |
| `JEKIMO_OBJECT_STORE_REGION` | `auto` | A region name | — | S3 region | [object-storage.md](object-storage.md#planned-configuration) | planned |
| `JEKIMO_OBJECT_STORE_ACCESS_KEY_ID` | unset | — | — | Credential | [object-storage.md](object-storage.md#planned-configuration) | planned |
| `JEKIMO_OBJECT_STORE_SECRET_ACCESS_KEY` | unset | — | — | Credential, secret | [object-storage.md](object-storage.md#planned-configuration) | planned |
| `JEKIMO_OBJECT_STORE_PATH_STYLE` | `true` | Boolean | — | Path-style addressing | [object-storage.md](object-storage.md#planned-configuration) | planned |
| `JEKIMO_HOT_DAYS_DEFAULT` | `14` | Integer | — | Hot period for new projects when a bucket is configured | [object-storage.md](object-storage.md#planned-configuration) | planned |
| `JEKIMO_HOT_DAYS_MAX` | `365` | Integer | — | Upper bound on `hot_days` | [object-storage.md](object-storage.md#planned-configuration) | planned |
| `JEKIMO_RESTORE_MAX_DAYS` | `31` | Integer | — | Days restorable in one request | [object-storage.md](object-storage.md#planned-configuration) | planned |
| `JEKIMO_RESTORE_TTL_DAYS` | `7` | Integer | — | How long restored partitions stay hot | [object-storage.md](object-storage.md#planned-configuration) | planned |
| `JEKIMO_BACKUP_KEEP_DAILY` | `14` | Integer | — | Daily backups kept | [object-storage.md](object-storage.md#planned-configuration) | planned |
| `JEKIMO_BACKUP_KEEP_MONTHLY` | `6` | Integer | — | Monthly backups kept | [object-storage.md](object-storage.md#planned-configuration) | planned |

## Production Compose file

Read by [`deploy/docker-compose/docker-compose.yml`](../deploy/docker-compose/docker-compose.yml) only, not by the services. The Compose file also passes each service the implemented settings above that it reads, with the defaults shown.

| Variable | Default | Meaning | Status |
| --- | --- | --- | --- |
| `JEKIMO_VERSION` | required | Image tag of `ghcr.io/bigbimbs/jekimo-api` and `ghcr.io/bigbimbs/jekimo-worker`. An exact release such as `0.2.0`; `edge` only for evaluation. | implemented |
| `JEKIMO_DOMAIN` | required | Public host name; Caddy serves it and gets its certificate. | implemented |
| `COMPOSE_PROFILES` | unset | `local-db` runs the local PostgreSQL service. Empty for an existing database. | implemented |
| `JEKIMO_DB_PASSWORD` | unset | With `local-db`: password of the runtime account, created on the first start and used in the default `JEKIMO_DATABASE_URL`. Hex (`openssl rand -hex 32`) so it needs no URL encoding. | implemented |
| `POSTGRES_ADMIN_PASSWORD` | unset | With `local-db`: superuser password used once to initialise an empty volume, then removed from the database. Delete it from `.env` after the first start. | implemented |

## Local development stack

Read by [`deploy/docker-compose/docker-compose.dev.yml`](../deploy/docker-compose/docker-compose.dev.yml) only.

| Variable | Default | Meaning | Status |
| --- | --- | --- | --- |
| `POSTGRES_PASSWORD` | required | Password of the local PostgreSQL container. | implemented |
| `JEKIMO_DEV_POSTGRES_PORT` | `5432` | Loopback port PostgreSQL is published on. | implemented |
| `JEKIMO_DEV_API_PORT` | `8080` | Loopback port the API is published on. | implemented |
