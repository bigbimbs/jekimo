# Event worker

Drains the durable ingest queue in PostgreSQL and turns accepted events into stored events, issue summaries, and daily counts, then keeps storage within retention.

For each queued ingest request it:

1. Applies the project sample rate with `shouldKeepEvent` (exceptions, errors, and fatals are never sampled).
2. Redacts `context` and `attributes` with `redactEvent` from `@jekimo/event-schema`, the same rules the Node SDK applies: the default key list plus the project's own rules ([docs/event-format.md](../../docs/event-format.md), "Privacy defaults"). Extra keys are normalized like the default list (lower-cased, `-`, `_`, and spaces removed); patterns are JavaScript regular expressions matched case-sensitively against the raw key name, as in the Node SDK. Rules are read once per project per batch, so a change applies from the next batch. A pattern that does not compile fails the job instead of storing an unredacted value.
3. Validates the event in stored form with `validateEvent(..., { mode: "stored" })`, checking future timestamps against the client's `sent_at` as the API did. An event that fails is not stored, is counted as dropped, and is logged with its index, `event_id`, and the failing paths and codes only. Unknown fields are removed.
4. Derives a fingerprint when the event has none with `deriveFingerprint` from `@jekimo/event-schema`: exception type plus in-app stack frames (all frames when none is in-app) with line and column numbers removed, otherwise the message with numbers, UUIDs, and hex strings replaced ([docs/event-format.md](../../docs/event-format.md), "Grouping").
5. Appends events to the event store. Appends are idempotent on `(project_id, event_id)`.
6. Derives counts per fingerprint from the event store and merges them into the `issues` table, with the job's latest event id (when the job holds the newest events) and the environments seen. Counts are never incremented blindly, so a retry converges. A `resolved` issue that receives an event received after it was resolved is reopened (a regression) and the change is audit-logged as `issue.regressed` with no actor; `ignored` issues stay ignored.
7. Adds the job's counts to the project's daily counters for the UTC day of `received_at`, with `job:<queue job id>` as the idempotency key, so a redelivered job is counted once.

The steps are separate and idempotent, event store first, with no transaction across the event store and metadata ([docs/architecture.md](../../docs/architecture.md), "Storage engines", rules 2 and 3). A job is acknowledged only after all of them succeed. Failed jobs are retried with exponential backoff and dead-lettered after the configured number of attempts. A job claimed by a worker that dies is redelivered after the visibility timeout and reprocessed without duplicate events or double counts. On `SIGTERM` or `SIGINT` the worker finishes every job it has claimed, then exits.

## Daily counters

| Counter | Written by | Counts |
| --- | --- | --- |
| `accepted` | worker | Events that passed stored validation and were kept after sampling. Repeats of events stored earlier count again, as they are listed in `accepted` in the `202`. |
| `rejected` | API | Per-event rejections in the `202` response. |
| `dropped` | worker, API | Events that failed stored validation (worker), and events in requests refused with `429 quota_exceeded` (API). |
| `sampled` | worker | Events dropped by the project sample rate. |

Every event in a job counts as exactly one of `accepted`, `dropped`, or `sampled`. Counter idempotency keys are kept for the 7-day deduplication window.

## Expiry

An expiry pass runs at start and then on an interval (15 minutes by default): it removes each project's UTC days whose last instant has passed the project's retention, oldest day first, recounts the issues of each project that lost events, prunes deduplication entries and counter idempotency keys older than 7 days, deletes daily counters older than 13 months, deletes audit log entries older than `JEKIMO_AUDIT_LOG_DAYS` (default 365, including entries about deleted projects, which are otherwise kept), and creates partitions for the coming week. A project's retention is its stored setting, or `JEKIMO_RETENTION_DEFAULT_DAYS` when that is not valid, and never more than `JEKIMO_RETENTION_MAX_DAYS`.

The pass is idempotent and safe to interrupt: expiring a day twice removes nothing the second time, and the first pass after a start or after a failed pass recounts every project's issues, so a pass stopped between removing events and recounting leaves no stale counts.

Every minute the worker reads free space on the database volume (`JEKIMO_DISK_PATH` or `JEKIMO_DISK_BUDGET_BYTES`, [docs/configuration.md](../../docs/configuration.md#disk-safety)). A change of level is logged and, at the warning level or worse, written to the audit log as `instance.disk_level_changed`. From the critical level until free space is back above the warning level, the pass runs every minute with each project's retention cut to at most 7 days, and logs `emergency expiry removed events` with the project id and count for each project that lost events. A reading that fails changes nothing: the worker never deletes data early on an unknown level.

## Recomputing issues

Issue counts are derived from the event store, so they can be rebuilt at any time:

```bash
npm run recompute-issues -w @jekimo/worker                  # every project
npm run recompute-issues -w @jekimo/worker -- prj_example   # one project
docker compose exec worker node dist/recompute.mjs           # in the worker image
```

For each project it sets every issue's count and first and last seen from the remaining events and deletes issues with none, keeping status, title, and environments. Issues the worker updates while it runs are left alone. The expiry pass does the same for each project it removed events from, so issues whose last event expired are deleted.

Not yet implemented: archiving to object storage instead of deleting. There is no API endpoint yet to set redaction rules or read counters; the storage methods are `setRedactionRules` and `listDailyCounters`.

## Development

```bash
npm run dev -w @jekimo/worker    # tsx watch, needs JEKIMO_DATABASE_URL
npm run build -w @jekimo/worker  # dist/main.mjs and dist/recompute.mjs
npm test -- apps/worker          # PostgreSQL tests run when JEKIMO_DATABASE_URL is set
```

Settings are in [docs/configuration.md](../../docs/configuration.md).

## Throughput benchmark

`bench/throughput.ts` creates a throwaway schema in the database named by `JEKIMO_DATABASE_URL`, enqueues synthetic ingest jobs (a mix of logs and exceptions across a few dozen fingerprints, with project redaction rules set), drains them with the real worker in one process, checks that every event was stored, prints the result as JSON, and drops the schema. Do not point it at a production database.

```bash
docker run -d --rm --name jekimo-bench-pg -e POSTGRES_PASSWORD=bench -p 55432:5432 postgres:16-alpine
JEKIMO_DATABASE_URL=postgres://postgres:bench@localhost:55432/postgres BENCH_JOBS=1000 npm run bench -w @jekimo/worker
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENCH_JOBS` | `200` | Queued ingest jobs. |
| `BENCH_EVENTS_PER_JOB` | `100` | Events per job, at most 100 as at ingest. |
| `JEKIMO_WORKER_BATCH_SIZE` | `10` | Jobs claimed per dequeue, as in production. |

`events_per_second` is the sustained drain rate of one worker. Compare it with the targets in [docs/retention.md](../../docs/retention.md), "Proposed targets for the first release" (1,000,000 events a month, bursts of 1,000 events a minute per project). For a result that means something for operators, run it on the reference VPS (2 vCPU, 4 GB RAM, PostgreSQL on the same host) and record the host with the numbers.
