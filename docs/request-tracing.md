# Request tracing, timing waterfalls, and integrations

The Node SDK can instrument a selected node-postgres `Client` or `Pool` and correlate its queries with logs and exceptions captured in the same request. Enable instrumentation once per target and wrap request handlers with `client.withSpan` for recorded durations or `client.withTrace` for correlation only. Jekimo does not patch global prototypes, inspect HTTP requests, or install framework middleware automatically.

Apply migration `0015_trace_lookup.sql` before updating the API. It adds a project-scoped trace lookup index to the event store. The feature uses existing `context` fields and does not change envelope schema version 1. Update the SDK build in your application; npm publication remains a separate maintainer action.

## Setup

```ts
import { Pool } from "pg";
import { init, instrumentPostgres } from "@jekimo/sdk-node";

const jekimo = init({
  baseUrl: process.env.JEKIMO_URL,
  ingestionKey: process.env.JEKIMO_INGESTION_KEY,
  service: "billing-api",
});
const pool = new Pool();
const instrumentation = instrumentPostgres(pool, {
  client: jekimo,
  name: "billing.database",
});

// In your application's request handler:
await jekimo.withSpan({ name: "GET /invoices/:id", operation: "http.server" }, async ({ traceId }) => {
  // Optionally expose traceId to your caller as a response header.
  jekimo.log("info", "Loading invoice");
  try {
    await pool.query("SELECT id FROM invoices WHERE id = $1", ["synthetic-invoice"]);
  } catch (error) {
    jekimo.captureException(error);
    throw error;
  }
});

// At application shutdown:
instrumentation.restore();
await jekimo.close();
await pool.end();
```

`withTrace` returns the callback's exact return value (including a promise) and preserves thrown values. It captures no telemetry of its own and does not convert a synchronous handler into an asynchronous one. Logs, exceptions, and database calls captured within it receive the same trace ID, including asynchronous descendants. Nested scopes retain the trace ID and identify the parent span. `getTraceContext()` returns a copy of the current context or `undefined` outside a scope. Contexts are isolated per SDK client and concurrent request, using Node's `AsyncLocalStorage`.

Use static route labels such as `GET /invoices/:id`, never raw URLs with customer IDs, query strings, or tokens. Names are limited to 128 characters; invalid names fall back to `request`. The SDK generates random IDs by default. For explicitly trusted cross-service correlation you can pass `traceId` (32 lowercase hexadecimal characters, nonzero) and `parentSpanId` (16 lowercase hexadecimal characters, nonzero). Invalid trace IDs start a fresh trace and discard the supplied parent. The helper does not parse or propagate W3C `traceparent` headers automatically, and a trace ID never grants project access.

The emitted context uses `trace_id`, `span_id`, optional `parent_span_id`, and `trace_name`. Database records receive their own span ID beneath the active scope. `withTrace` emits no root timing record. Use `withSpan` or `startSpan` below to record one. Async tasks created inside a scope can retain its context after the handler returns; wrap independent background work in a new explicit trace when it should not belong to that request. Scope fields take precedence over manually supplied correlation context. `captureContext: false` and configured context-key redaction still apply.

## PostgreSQL adapter scope

The integration supports standard promise and callback forms of `query` on the selected target, including ordinary query-config objects. It preserves the query receiver, argument objects, result objects, and original errors. Callback receivers and return values are preserved, and delayed callbacks run in the originating request context. Promise queries return a chained promise that preserves their resolution/rejection, not necessarily the original promise object's identity.

It does not read SQL, parameters, rows, connection strings, or database error messages. Every call through that target uses the static configured name (default `postgres.query`) and operation (default `other`). You may supply an explicit static `operation` such as `select`; the adapter does not infer it by parsing SQL. Keep `traceQuery` for places that need a distinct per-operation name.

Supported and excluded paths:

- `pool.query(...)` and `client.query(...)`: instrument the instance whose method the application calls.
- `pool.connect()` clients: not automatically instrumented. Instrument a checked-out client separately and restore it **before returning it to the pool**.
- Do not instrument both a pool and its internal/checked-out clients at the same time, or wrap an already instrumented call with `traceQuery`; that can produce two measurements.
- Query/Submittable objects, cursors, streams, and config objects containing a `callback` property: passed through without instrumentation. Use standard callback arguments or explicit duration reporting for these paths.
- Instrumentation is explicit. A Prisma model-query extension is available below; Sequelize, TypeORM, and other ORM-specific hooks are not included.

The handle reports `installed`. Reinstalling with the same SDK client returns the existing handle; a different client cannot take over an instrumented target. Frozen/non-configurable targets return an uninstalled handle. `restore()` stops future instrumentation and restores the original property when it still owns the wrapper, preserving wrappers installed afterward. Queries already in flight may still report their completion. Reporting failures do not replace database results or errors. Monitoring retains the SDK's existing bounded queue and asynchronous delivery; disabled or closed clients pass calls through without collecting new timings.

## Trace view and API

Open **Traces**, enter a trace ID, and choose the last 24 hours or seven days. Or follow **View request trace** from a database call, log/custom-event detail, or an issue's latest event. Those links use a two-day receipt window centered on the selected record, so older retained requests remain discoverable.

The page combines all event kinds and database calls, newest received first, with cursor pagination. Query durations and statuses are shown alongside messages, service, environment, and expandable record details. The waterfall shows recorded span timings and database calls in start-time order, with parent indentation, durations, offsets, failure labels and links to record details. Only loaded pages are included: load more records to expand it. Missing parents are labelled; malformed or redacted timing fields are omitted from the waterfall but remain in the record list. Sampling, redaction, retention, and delivery loss may remove records. A correlation-only scope with no captured events will not appear.

`GET /api/v1/projects/:id/events?trace_id=<id>` filters existing event queries by exact trace ID. It uses the normal session and `project.read` check, receipt-time filters, and cursor pagination. Other filters can be combined, or omitted to include all kinds. Malformed, uppercase, and all-zero IDs return 400. The server never looks up another project's records, even when two projects use the same trace ID. Context values outside this ID format remain permitted by the envelope but cannot be searched through this filter.

## Recorded spans

```ts
const result = await jekimo.withSpan({ name: "invoice.render", operation: "task" }, async () => {
  return renderInvoice();
});

// For callback-driven lifecycles:
const span = jekimo.startSpan({ name: "invoice.send", operation: "task" });
span.run(() => beginSend((error) => span.end(error ? "error" : "ok")));
```

`withSpan` always returns a promise, preserves its resolved value or original thrown/rejected value, and completes the span in either case. `startSpan` returns a frozen context plus `run` and idempotent `end`; call `end` on every completion/error/abort path. `run` activates the context only for its callback and async descendants. Spans that never end (including process crashes) produce no completed timing record. No global list of active spans is retained.

Timings use a wall-clock start and monotonic elapsed duration; the maximum recorded duration is seven days. Spans use ordinary `event`/`info` envelopes, `timestamp` at start, a reserved `jekimo.span:<span-id>` fingerprint, and string context entries `span_type=span`, `span_started_at` (ISO timestamp), `span_duration_ms`, `span_status` (`ok`/`error`) and `span_operation`, alongside the existing correlation keys. Static names/categories are limited to 128 characters. The reserved fingerprint prevents spans from becoming issues, even if context is removed. Update API/worker together before using these spans; existing migration 0015 suffices. They consume normal ingestion quota, queue capacity and retention and follow ordinary event sampling/redaction. A failed span remains informational; capture an exception separately when an error issue is wanted. Context suppression removes the waterfall's timing/correlation data.

The waterfall's database start time is estimated as event timestamp minus measured duration; it does not represent a database server's execution-only time. Span durations are not summed into request time because spans can overlap. Cross-service clock skew, absent records and independently sampled events can distort the picture. This is a waterfall of available recordings, not guaranteed complete distributed tracing.

## Fastify request hooks

Register these hooks once, **before routes**, in the Fastify scope to monitor:

```ts
import { createFastifyTracingHooks } from "@jekimo/sdk-node";
const tracing = createFastifyTracingHooks(jekimo);
app.addHook("onRequest", tracing.onRequest);
app.addHook("onResponse", tracing.onResponse);
app.addHook("onTimeout", tracing.onTimeout);
app.addHook("onRequestAbort", tracing.onRequestAbort);
```

Each matched request starts an `http.server` span named with the method and static route template (for example `GET /invoices/:id`). It finishes on response, timeout or request abort, once only. Responses with status 500 or higher, timeouts and aborts mark the span failed; handled errors returning a lower status count as completed. Unmatched requests without a route template are skipped. It does not read raw URLs, headers, request/response bodies or error messages, and does not automatically capture exceptions or propagate incoming trace headers. Fastify's abort/timeout hooks depend on its server lifecycle and timeout configuration. Registering multiple hook sets creates duplicate measurements. Hooks apply within Fastify's encapsulation boundaries; they do not patch the application globally.

## Prisma model-query extension

```ts
import { createPrismaTracingExtension } from "@jekimo/sdk-node";
const monitoredPrisma = prisma.$extends(createPrismaTracingExtension({
  client: jekimo,
  system: "postgresql",
}));
await jekimo.withSpan({ name: "GET /invoices" }, () => monitoredPrisma.invoice.findMany());
```

Use the returned extended client. `$allModels.$allOperations` records static model/operation labels (for example `Invoice.findMany`) and maps reads, creates, updates and deletes to database operation categories; unknown operations are `other`. It passes argument and result objects through and rethrows original errors without recording their content. It measures the awaited client operation, including client/extension overhead; it does not count every database round trip or nested write separately. Raw queries, connection setup, and transaction orchestration are not measured as model calls. Extensions inside interactive/batch transactions follow Prisma's extension behavior; do not assume one span per SQL statement. Avoid combining this with PostgreSQL-driver instrumentation of the same calls, or measurements may be duplicated. No ORM dependency is bundled in the SDK.

## Remaining work

Broader framework/ORM coverage, trace-wide sampling, automatic header propagation, OpenTelemetry support and guaranteed cross-service trace completeness remain future work. Query notifications continue to use the existing per-call slow-query rules.

API references used for the adapter: [node-postgres queries](https://node-postgres.com/features/queries), [node-postgres Client](https://node-postgres.com/apis/client), and [Node asynchronous context tracking](https://nodejs.org/api/async_context.html).

Integration references: [Fastify lifecycle hooks](https://fastify.dev/docs/latest/Reference/Hooks/) and [Prisma query extensions](https://www.prisma.io/docs/orm/v7/prisma-client/client-extensions/query).
