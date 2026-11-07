# PostgreSQL storage

Owns PostgreSQL connections, schema migrations, and project-scoped persistence. No code outside this package writes SQL. It implements the storage boundaries from [docs/architecture.md](../../docs/architecture.md), "Storage engines":

- **`MetadataRepository`** (`PostgresMetadataRepository`): users, sessions, projects, roles, memberships, ingestion keys, issues, and the audit log. Project data is only reachable through a `ProjectAccess`, which only `resolveProjectAccess` can create after checking membership or instance-admin authority.
- **`EventStore`** (`PostgresEventStore`): `appendEvents`, `queryEvents`, `summarizeFingerprints`, `expireDay`, and `archiveDay` (a Phase 2 stub), each taking a mandatory `project_id`. Another engine can implement this interface without touching metadata.
- **`Queue`** (`PostgresQueue`): the durable queue between the API and the worker. Jobs are claimed with `FOR UPDATE SKIP LOCKED`, hidden for a visibility timeout, retried with exponential backoff, and dead-lettered after the maximum number of attempts.

## Schema

Migrations are plain SQL in `migrations/`, applied in order, each in a transaction, and recorded in `schema_migrations`:

| File | Contents |
| --- | --- |
| `0001_metadata.sql` | `users`, `sessions`, `projects`, `project_roles`, `project_members`, `ingestion_keys` (`key_id` plaintext, `key_hash` SHA-256), `issues`, `audit_log` |
| `0002_event_store.sql` | `events` partitioned by range on `received_at` per UTC day, `event_ids` deduplication index, `ensure_event_partition()` |
| `0003_queue.sql` | `queue_jobs` |

Event indexes: BRIN on `received_at`; b-tree on `(project_id, received_at)`, `(project_id, fingerprint)`, and `(project_id, severity, received_at)`.

PostgreSQL requires a unique index on a partitioned table to include the partition key, so the unique index on `events` is `(project_id, event_id, received_at)`. Cross-request deduplication uses the unpartitioned `event_ids` table, whose primary key is `(project_id, event_id)`: `appendEvents` inserts there with `ON CONFLICT DO NOTHING` and only writes event rows for ids that were new, in one transaction. Entries are kept for 7 days, the deduplication window in [docs/retention.md](../../docs/retention.md).

Expiring a day deletes one project's rows from that day's partition. When no project has rows left in a past day, the partition is detached and then dropped.

## Usage

```bash
npm run migrate -w @jekimo/storage-postgres   # applies migrations, then creates partitions for the next week
```

Unit tests use the in-memory doubles from `@jekimo/storage-postgres/memory`. Integration tests in `test/postgres.test.ts` run against `DATABASE_URL` when it is set, each in a throwaway schema, and are skipped otherwise.
