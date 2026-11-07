# PostgreSQL storage

Owns PostgreSQL connections, schema migrations, and project-scoped persistence. No code outside this package writes SQL. It implements the storage boundaries from [docs/architecture.md](../../docs/architecture.md), "Storage engines":

- **`MetadataRepository`** (`PostgresMetadataRepository`): users, sessions, projects, roles, memberships, ingestion keys, issues, project daily counters, project redaction rules, and the audit log. Project data is only reachable through a `ProjectAccess`, which only `resolveProjectAccess` can create after checking membership or instance-admin authority, or by a `project_id` the API derived from an ingestion key.
- **Cross-project reads** (`src/cross-project.ts`): the project listing for a member or instance admin, ingestion key lookup, and the instance-wide retention listing for the expiry pass. They are the only queries without a project id ([docs/access-model.md](../../docs/access-model.md), "Authorization enforcement", rule 1).
- **`EventStore`** (`PostgresEventStore`): `appendEvents`, `queryEvents`, `getEvent`, `summarizeFingerprints`, `expireDay`, and `archiveDay` (a Phase 2 stub), each taking a mandatory `project_id`. Another engine can implement this interface without touching metadata. `queryEvents` filters by time range, severity, kind, environment, release, fingerprint, and words of the message, in the boundary's own terms. Text search is an optional capability (`capabilities.textSearch`), because it is cheap here and may be expensive elsewhere; callers check it and degrade.
- **`Queue`** (`PostgresQueue`): the durable queue between the API and the worker. Jobs are claimed with `FOR UPDATE SKIP LOCKED`, hidden for a visibility timeout, retried with exponential backoff, and dead-lettered after the maximum number of attempts. `enqueue` throws `QueueFullError` once `maxDepth` jobs are pending or running, and `stats()` returns the depth, the oldest job's age, and the dead-lettered count.

### Daily counters and redaction rules

`incrementDailyCounters(projectId, { day, accepted, rejected, dropped, sampled, idempotencyKey })` adds to one project's counts for one UTC day in a single statement. With an `idempotencyKey` (for example `job:<queue job id>`), a repeat of the key for that project adds nothing and returns `false`, so a redelivered job is not counted twice. `listDailyCounters(access, { from, to })` reads them with `project.read`. `pruneDailyCounters(beforeDay, keysBefore)` deletes counters older than the 13-month retention and old idempotency keys.

`setRedactionRules(access, { keys, patterns })` stores operator rules on top of the default key list, with `settings.manage`. Keys are normalized like the default list; patterns must compile as JavaScript regular expressions. The audit log records how many keys and patterns were set, not the rules. `getRedactionRules(projectId)` is for the worker.

## Schema

Migrations are plain SQL in `migrations/`, applied in order, each in a transaction, and recorded in `schema_migrations`:

| File | Contents |
| --- | --- |
| `0001_metadata.sql` | `users`, `sessions`, `projects`, `project_roles`, `project_members`, `ingestion_keys` (`key_id` plaintext, `key_hash` SHA-256), `issues`, `audit_log` |
| `0002_event_store.sql` | `events` partitioned by range on `received_at` per UTC day, `event_ids` deduplication index, `ensure_event_partition()` |
| `0003_queue.sql` | `queue_jobs` |
| `0004_project_daily_counters.sql` | `project_daily_counters` (accepted, rejected, dropped, sampled per project per UTC day), `project_counter_increments` (idempotency keys) |
| `0005_project_redaction_rules.sql` | `projects.redaction_rules` (`{"keys": [], "patterns": []}`) |
| `0006_event_message_search.sql` | GIN index on `to_tsvector('simple', ...)` of `message`, with punctuation turned into word breaks |

Event indexes: BRIN on `received_at`; b-tree on `(project_id, received_at)`, `(project_id, fingerprint)`, and `(project_id, severity, received_at)`; GIN on the `message` search vector. `attributes` has no index.

PostgreSQL requires a unique index on a partitioned table to include the partition key, so the unique index on `events` is `(project_id, event_id, received_at)`. It is the one b-tree beyond the list in `docs/architecture.md`: it is what `ON CONFLICT DO NOTHING` on `events` resolves against, so a batch replayed with the same `received_at` (a redelivered queue job whose `event_ids` entry was already pruned) cannot store a row twice, and it serves `getEvent` with one index probe per day partition. Cross-request deduplication uses the unpartitioned `event_ids` table, whose primary key is `(project_id, event_id)`: `appendEvents` inserts there with `ON CONFLICT DO NOTHING` and only writes event rows for ids that were new, in one transaction. Entries are kept for 7 days, the deduplication window in [docs/retention.md](../../docs/retention.md).

Day partitions are shared by every project, so `expireDay(project, day)` takes one of two paths ([docs/retention.md](../../docs/retention.md), "Expiry mechanics"):

- **Only this project has rows in a past day's partition** (the usual case on an instance with one project, and for the last project to expire a day): the partition is detached in one transaction and dropped in another. Queries stop seeing the day when the detach commits. If the process dies before the drop, the detached table is still reported by `listDays`, and the next call for that day drops it and reports its rows.
- **Other projects still have rows there, or the day is today**: the project's rows are deleted in a single transaction, using the `(project_id, received_at)` index. PostgreSQL applies it entirely or, if interrupted, not at all.

Either way an interrupted run leaves the whole day visible or none of it. The check and the detach hold a `SHARE ROW EXCLUSIVE` lock on the partition, which blocks appends and concurrent expiry of that day but not reads. Sub-partitioning each day by project would make every expiry a detach, but multiplies the partition count by the number of projects, so it is not done.

## Connection

The connection string is read from `JEKIMO_DATABASE_URL`. The older `DATABASE_URL` is still read when `JEKIMO_DATABASE_URL` is unset, with a deprecation warning. Neither the password nor the connection string is ever logged; a missing setting fails with a message naming the variable only.

## Database privileges

The first release uses one account for migrations and runtime. That account needs:

| Privilege | Why |
| --- | --- |
| `CONNECT` on the Jekimo database | To connect. |
| `USAGE` and `CREATE` on the schema Jekimo uses (`public` by default) | Migrations create tables, indexes, and the `ensure_event_partition` function; the worker creates a partition per UTC day. |
| Ownership of the tables Jekimo creates | `ALTER TABLE events DETACH PARTITION` and `DROP TABLE` on expired daily partitions require ownership. Creating the tables as this account gives it ownership. |
| `SELECT`, `INSERT`, `UPDATE`, `DELETE` on those tables | Ordinary reads and writes (implied by ownership). |

It needs no superuser, `CREATEDB`, `CREATEROLE`, `REPLICATION`, or `BYPASSRLS` attribute, no extensions (`gen_random_uuid()` is built into PostgreSQL 13 and later), and no access to any other database or schema. Session-level advisory locks (`pg_advisory_lock`), which the migration runner uses so concurrent runs wait for each other, are available to every account. [docs/install-vps.md](../../docs/install-vps.md#option-2-an-existing-postgresql-server), "Option 2", has the SQL that creates such an account, and [docs/database-setup.md](../../docs/database-setup.md) specifies how setup provisions it.

## Usage

```bash
npm run migrate -w @jekimo/storage-postgres   # applies migrations, then creates partitions for the next week
```

`runMigrations(pool)` does the same from code; the API and worker call it at start-up when `JEKIMO_MIGRATE_ON_START=true` ([docs/configuration.md](../../docs/configuration.md#database)). Running it again is a no-op.

Unit tests use the in-memory doubles from `@jekimo/storage-postgres/memory`. Integration tests in `test/postgres.test.ts` run against `JEKIMO_DATABASE_URL` (or the deprecated `DATABASE_URL`) when it is set, each in a throwaway schema, and are skipped otherwise.
