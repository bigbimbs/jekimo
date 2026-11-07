# PostgreSQL storage

Owns PostgreSQL connections, schema migrations, and project-scoped persistence. No code outside this package writes SQL. It implements the storage boundaries from [docs/architecture.md](../../docs/architecture.md), "Storage engines":

- **`MetadataRepository`** (`PostgresMetadataRepository`): users, sessions, projects, roles, memberships, ingestion keys, issues, and the audit log. Project data is only reachable through a `ProjectAccess`, which only `resolveProjectAccess` can create after checking membership or instance-admin authority.
- **`EventStore`** (`PostgresEventStore`): `appendEvents`, `queryEvents`, `getEvent`, `summarizeFingerprints`, `expireDay`, and `archiveDay` (a Phase 2 stub), each taking a mandatory `project_id`. Another engine can implement this interface without touching metadata. `queryEvents` filters by time range, severity, kind, environment, release, fingerprint, and words of the message, in the boundary's own terms. Text search is an optional capability (`capabilities.textSearch`), because it is cheap here and may be expensive elsewhere; callers check it and degrade.
- **`Queue`** (`PostgresQueue`): the durable queue between the API and the worker. Jobs are claimed with `FOR UPDATE SKIP LOCKED`, hidden for a visibility timeout, retried with exponential backoff, and dead-lettered after the maximum number of attempts.

## Schema

Migrations are plain SQL in `migrations/`, applied in order, each in a transaction, and recorded in `schema_migrations`:

| File | Contents |
| --- | --- |
| `0001_metadata.sql` | `users`, `sessions`, `projects`, `project_roles`, `project_members`, `ingestion_keys` (`key_id` plaintext, `key_hash` SHA-256), `issues`, `audit_log` |
| `0002_event_store.sql` | `events` partitioned by range on `received_at` per UTC day, `event_ids` deduplication index, `ensure_event_partition()` |
| `0003_queue.sql` | `queue_jobs` |
| `0006_event_message_search.sql` | GIN index on `to_tsvector('simple', ...)` of `message`, with punctuation turned into word breaks |

Event indexes: BRIN on `received_at`; b-tree on `(project_id, received_at)`, `(project_id, fingerprint)`, and `(project_id, severity, received_at)`; GIN on the `message` search vector. `attributes` has no index.

PostgreSQL requires a unique index on a partitioned table to include the partition key, so the unique index on `events` is `(project_id, event_id, received_at)`. It is the one b-tree beyond the list in `docs/architecture.md`: it is what `ON CONFLICT DO NOTHING` on `events` resolves against, so a batch replayed with the same `received_at` (a redelivered queue job whose `event_ids` entry was already pruned) cannot store a row twice, and it serves `getEvent` with one index probe per day partition. Cross-request deduplication uses the unpartitioned `event_ids` table, whose primary key is `(project_id, event_id)`: `appendEvents` inserts there with `ON CONFLICT DO NOTHING` and only writes event rows for ids that were new, in one transaction. Entries are kept for 7 days, the deduplication window in [docs/retention.md](../../docs/retention.md).

Day partitions are shared by every project, so `expireDay(project, day)` takes one of two paths ([docs/retention.md](../../docs/retention.md), "Expiry mechanics"):

- **Only this project has rows in a past day's partition** (the usual case on an instance with one project, and for the last project to expire a day): the partition is detached in one transaction and dropped in another. Queries stop seeing the day when the detach commits. If the process dies before the drop, the detached table is still reported by `listDays`, and the next call for that day drops it and reports its rows.
- **Other projects still have rows there, or the day is today**: the project's rows are deleted in a single transaction, using the `(project_id, received_at)` index. PostgreSQL applies it entirely or, if interrupted, not at all.

Either way an interrupted run leaves the whole day visible or none of it. The check and the detach hold a `SHARE ROW EXCLUSIVE` lock on the partition, which blocks appends and concurrent expiry of that day but not reads. Sub-partitioning each day by project would make every expiry a detach, but multiplies the partition count by the number of projects, so it is not done.

## Usage

```bash
npm run migrate -w @jekimo/storage-postgres   # applies migrations, then creates partitions for the next week
```

Unit tests use the in-memory doubles from `@jekimo/storage-postgres/memory`. Integration tests in `test/postgres.test.ts` run against `DATABASE_URL` when it is set, each in a throwaway schema, and are skipped otherwise.
