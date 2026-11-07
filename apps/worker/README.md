# Event worker

Drains the durable ingest queue in PostgreSQL and turns accepted events into stored events, issue summaries, and daily counts, then keeps storage within retention.

For each queued ingest request it:

1. Applies the project sample rate with `shouldKeepEvent` (exceptions, errors, and fatals are never sampled).
2. Redacts `context` and `attributes` with `redactEvent` from `@jekimo/event-schema`, the same rules the Node SDK applies: the default key list plus the project's own rules ([docs/event-format.md](../../docs/event-format.md), "Privacy defaults"). Extra keys are normalized like the default list (lower-cased, `-`, `_`, and spaces removed); patterns are JavaScript regular expressions matched case-sensitively against the raw key name, as in the Node SDK. Rules are read once per project per batch, so a change applies from the next batch. A pattern that does not compile fails the job instead of storing an unredacted value.
3. Validates the event in stored form with `validateEvent(..., { mode: "stored" })`, checking future timestamps against the client's `sent_at` as the API did. An event that fails is not stored, is counted as dropped, and is logged with its index, `event_id`, and the failing paths and codes only. Unknown fields are removed.
4. Derives a fingerprint when the event has none with `deriveFingerprint` from `@jekimo/event-schema`: exception type plus in-app stack frames (all frames when none is in-app) with line and column numbers removed, otherwise the message with numbers, UUIDs, and hex strings replaced ([docs/event-format.md](../../docs/event-format.md), "Grouping").
5. Appends events to the event store. Appends are idempotent on `(project_id, event_id)`.
6. Derives counts per fingerprint from the event store and merges them into the `issues` table. Counts are never incremented blindly, so a retry converges.
7. Adds the job's counts to the project's daily counters for the UTC day of `received_at`, with `job:<queue job id>` as the idempotency key, so a redelivered job is counted once.

The steps are separate and idempotent, event store first, with no transaction across the event store and metadata ([docs/architecture.md](../../docs/architecture.md), "Storage engines", rules 2 and 3). A job is acknowledged only after all of them succeed. Failed jobs are retried with exponential backoff and dead-lettered after the configured number of attempts. A job claimed by a worker that dies is redelivered after the visibility timeout and reprocessed without duplicate events or double counts. On `SIGTERM` or `SIGINT` the worker finishes every job it has claimed, then exits.

## Daily counters

| Counter | Written by | Counts |
| --- | --- | --- |
| `accepted` | worker | Events that passed stored validation and were kept after sampling. Repeats of events stored earlier count again, as they are listed in `accepted` in the `202`. |
| `rejected` | API | Per-event rejections in the `202` response. |
| `dropped` | worker | Events that failed stored validation. Over-quota drops will be added with quotas. |
| `sampled` | worker | Events dropped by the project sample rate. |

Every event in a job counts as exactly one of `accepted`, `dropped`, or `sampled`. Counter idempotency keys are kept for the 7-day deduplication window.

## Expiry

An expiry pass runs at start and then on an interval (15 minutes by default): it removes each project's UTC days whose last instant has passed the project's retention, recounts that project's issues, prunes deduplication entries and counter idempotency keys older than 7 days, deletes daily counters older than 13 months, and creates partitions for the coming week.

Not yet implemented: disk-pressure emergency expiry and archiving to object storage. There is no API endpoint yet to set redaction rules or read counters; the storage methods are `setRedactionRules` and `listDailyCounters`.

## Development

```bash
npm run dev -w @jekimo/worker    # tsx watch, needs JEKIMO_DATABASE_URL
npm run build -w @jekimo/worker  # dist/main.mjs
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
