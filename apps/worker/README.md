# Event worker

Drains the durable ingest queue in PostgreSQL and turns accepted events into stored events and issue summaries, then keeps storage within retention.

For each queued ingest request it:

1. Applies the project sample rate with `shouldKeepEvent` (exceptions, errors, and fatals are never sampled).
2. Re-applies the default redaction key list to `context` and `attributes`.
3. Derives a fingerprint when the event has none: exception type plus in-app stack frames with line numbers removed, otherwise the message with numbers, UUIDs, and hex strings replaced (see `src/fingerprint.ts` and [docs/event-format.md](../../docs/event-format.md), "Grouping").
4. Appends events to the event store. Appends are idempotent on `(project_id, event_id)`.
5. Derives counts per fingerprint from the event store and merges them into the `issues` table. Counts are never incremented blindly, so a retry converges.

Failed jobs are retried with exponential backoff and dead-lettered after the configured number of attempts.

An expiry pass runs at start and then on an interval (15 minutes by default): it removes each project's UTC days whose last instant has passed the project's retention, recounts that project's issues, prunes deduplication entries older than 7 days, and creates partitions for the coming week.

Not yet implemented: project-level redaction rules, daily counters, disk-pressure emergency expiry, and archiving to object storage.

## Development

```bash
npm run dev -w @jekimo/worker    # tsx watch, needs JEKIMO_DATABASE_URL
npm run build -w @jekimo/worker  # dist/main.mjs
npm test -- apps/worker
```

Settings are in [docs/configuration.md](../../docs/configuration.md).
