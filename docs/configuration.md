# Configuration

Every runtime setting is an environment variable. Never include real credentials in examples; [`.env.example`](../.env.example) at the repository root has safe placeholders, and local `.env` files stay out of version control.

Invalid values stop the service at start-up with a message naming the variable, never echoing its value.

## Database

Read by `apps/api`, `apps/worker`, and `npm run migrate`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL connection string, for example `postgres://jekimo:<password>@127.0.0.1:5432/jekimo`. |
| `JEKIMO_DATABASE_POOL_MAX` | `10` | Maximum connections per process. |
| `JEKIMO_MIGRATIONS_DIR` | the `migrations/` directory of `packages/storage-postgres` | Where the migration runner looks for `NNNN_description.sql` files. The API image sets it to `/app/migrations`. |

The first release uses one database role for migrations and runtime. A restricted runtime role, with setup-time administrator credentials discarded after setup, is still to come (see [access-model.md](access-model.md), "Setup flow").

## API

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEKIMO_API_HOST` | `127.0.0.1` | Listen address. The container image sets `0.0.0.0`. |
| `JEKIMO_API_PORT` | `8080` | Listen port. |
| `JEKIMO_LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, or `trace`. Logs are JSON and never contain ingestion keys, passwords, session tokens, or event payloads. |
| `JEKIMO_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` from a reverse proxy when recording the client address in the audit log. Enable only behind a proxy you control. |
| `JEKIMO_MEMBERS_CAN_CREATE_PROJECTS` | `true` | Whether instance members, not only admins, may create projects. |
| `JEKIMO_SESSION_IDLE_DAYS` | `14` | Session idle timeout. At most `JEKIMO_SESSION_MAX_DAYS`. |
| `JEKIMO_SESSION_MAX_DAYS` | `30` | Session absolute lifetime. |
| `JEKIMO_RETENTION_DEFAULT_DAYS` | `30` | Retention for new projects. |
| `JEKIMO_RETENTION_MAX_DAYS` | `3650` | Upper bound for a project's retention. |

The API terminates plain HTTP. In production put it behind a TLS-terminating reverse proxy; session cookies are always marked `Secure`. Plain HTTP is only acceptable on the loopback interface for local development.

## Queue and worker

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `JEKIMO_QUEUE_MAX_ATTEMPTS` | API | `5` | Attempts before a queued ingest job is dead-lettered. Stamped on each job at enqueue time. |
| `JEKIMO_QUEUE_VISIBILITY_SECONDS` | worker | `60` | How long a claimed job is hidden from other workers before it is redelivered. |
| `JEKIMO_WORKER_BATCH_SIZE` | worker | `10` | Jobs claimed per poll. Each job is one ingest request of up to 100 events. |
| `JEKIMO_WORKER_POLL_MS` | worker | `1000` | Wait between polls when the queue is empty. |
| `JEKIMO_EXPIRY_INTERVAL_MINUTES` | worker | `15` | Interval of the expiry pass, 1 to 15 ([retention.md](retention.md) requires at least every 15 minutes). |
| `JEKIMO_LOG_LEVEL` | worker | `info` | As for the API. |

Dead-lettered jobs stay in the `queue_jobs` table with `status = 'dead'` and a payload-free `last_error` for inspection.

## Local development stack

Read by [`deploy/docker-compose/docker-compose.dev.yml`](../deploy/docker-compose/docker-compose.dev.yml) only.

| Variable | Default | Meaning |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | required | Password of the local PostgreSQL container. |
| `JEKIMO_DEV_POSTGRES_PORT` | `5432` | Loopback port PostgreSQL is published on. |
| `JEKIMO_DEV_API_PORT` | `8080` | Loopback port the API is published on. |

## Planned settings

These are specified but not implemented yet. [`.env.example`](../.env.example) lists each one with its documented default, grouped by spec, and each spec lists its own variables:

- Disk thresholds and audit log retention: [retention.md](retention.md)
- Invitations and SMTP: [access-model.md](access-model.md)
- Ingestion rate limits and quotas: [ingestion-protocol.md](ingestion-protocol.md)
- Object storage, cold tier, restores, and backups: [object-storage.md](object-storage.md)

All Jekimo variables are prefixed `JEKIMO_`, except `DATABASE_URL` and the PostgreSQL container's `POSTGRES_PASSWORD`.
