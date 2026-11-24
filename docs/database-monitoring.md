# Database query monitoring

Jekimo records database calls through explicit capture or opt-in PostgreSQL client/pool instrumentation. It does not connect to your application database, run queries, or install automatic ORM hooks. The first version includes manual duration capture, a Node.js callback wrapper, per-project performance summaries, and recent calls. SQL statements, parameters, returned rows, connection strings, and exception messages are not collected by these helpers.

## Enable recording

Apply migration `0013_database_queries.sql`, then update the API and worker before updating application SDKs. The additive `database` envelope field uses schema version 1. Older servers discard that field and can treat its message as an ordinary custom event, so upgrade the server first. SDK publication to npm is a separate maintainer action.

```ts
import { init } from "@jekimo/sdk-node";

const jekimo = init({
  baseUrl: process.env.JEKIMO_URL,
  ingestionKey: process.env.JEKIMO_INGESTION_KEY,
  service: "billing-api",
  environment: "production",
});

const invoices = await jekimo.traceQuery(
  { name: "invoices.list", system: "postgresql", operation: "select" },
  () => db.query("SELECT id FROM invoices WHERE status = $1", ["pending"]),
);
```

`db` is your own database client; the callback executes exactly once. `traceQuery` measures elapsed time with a monotonic clock, including waits inside the callback. It supports synchronous return values and promises, returns the original result, and rethrows the original failure. Reporting errors do not replace the application result. The helper never examines the callback's arguments or result and does not attach the thrown error. Record an exception separately if desired, following the normal privacy policy.

Use static names such as `invoices.list`. Never put SQL, IDs, customer data, parameters, or connection strings in the name. Names are limited to 128 characters; high-cardinality names also make grouping less useful. The system is `postgresql`, `mysql`, `sqlite`, `mongodb`, `redis`, or `other`; operation is `select`, `insert`, `update`, `delete`, or `other`.

For a database library that already measures duration:

```ts
jekimo.captureQuery({
  name: "invoices.list",
  system: "postgresql",
  operation: "select",
  duration_ms: 240.5,
  status: "ok", // or "error"
});
```

Durations must be finite and between zero and seven days in milliseconds. Invalid records are dropped and reported through the SDK's existing error hook. Instrumentation sends asynchronously through the existing bounded queue, with the same batching, retries, rate limits, quotas, sampling, and disk-safety behavior as other events. Call `close()` at shutdown for short-lived applications. Both successful and failed query records use `kind: event`, `severity: info`, and are eligible for normal event sampling.

## Dashboard

Open **Database** at `/projects/:projectId/database`. Select the last hour, 24 hours, or seven days, optionally filter by exact environment, and choose a slow-query threshold (default 200 ms). Apply and refresh advances the receipt window; there is no background polling.

The page shows recorded calls, failed calls, slow calls, average duration, and the 95th percentile. Slow calls have duration greater than or equal to the selected threshold. Operation groups are identified by name, database system, and operation, and ranked by total recorded duration. At most 100 groups and the latest 25 calls are displayed. Totals cover all matching records, including groups outside the top 100. Percentiles use linear interpolation, not an average of group percentiles.

Metrics describe retained, recorded calls, not every call made against the database. Sampling, queue drops, lost delivery, retention, and the callback's scope affect these figures. They do not measure database CPU usage or isolate connection-pool wait time. Queries are stored alongside events for deduplication, retention, export, and project isolation, but are excluded from issue grouping and the Logs/Events lists. Raw event queries and NDJSON exports still include them unless explicitly filtered.

## API

`GET /api/v1/projects/:id/database/summary` requires a dashboard session and `project.read`. Ingestion keys never grant dashboard access. Optional parameters:

- `from` (inclusive) and `to` (exclusive), RFC 3339 receipt times. Defaults to the previous 24 hours; maximum window seven days.
- `environment`, an exact environment name.
- `slow_ms`, finite number from 0 to 604800000, default 200.

Returns `from`, `to`, `slow_ms`, `totals`, `groups`, and `recent`. Metrics contain `count`, `errors`, `slow`, `averageMs`, `p95Ms`, and `totalMs`. `recent` uses the normal public stored-event response shape. `GET /api/v1/projects/:id/events` also accepts `database=true` or `database=false`, with normal cursor pagination. Omitting the filter preserves existing behavior.

No additional database credentials are needed: reporting uses the project's existing ingestion key. Database telemetry uses the normal ingestion endpoint; the server assigns its project from that key.

## Slow-query notifications

Project administrators can create **A database call is slow** rules under **Alerts**, using an existing email, Slack, or webhook connection. Rules save an inclusive per-call threshold, optional exact environment/name filters, and a cooldown shared across matches. The Database page's exploration threshold does not modify these saved rules. See [notifications.md](notifications.md#slow-query-rules) for receipt windows, deduplication, and delivery behavior.

## Next capabilities

ORM-specific integrations, distributed timing waterfalls, query-plan analysis, aggregate latency alerts, and SQL normalization are not implemented. This first version deliberately collects named operations and timings only. Slow-query notifications use their own rule trigger and do not create issues.

## PostgreSQL instrumentation and request correlation

Instrument a selected PostgreSQL client or pool once with `instrumentPostgres`, and use `withTrace` to correlate its queries with logs and errors. The integration does not collect SQL or query arguments. See [request tracing](request-tracing.md) for supported query forms, safe labels, and limitations.
