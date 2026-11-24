# PostgreSQL instrumentation and request correlation

The Node SDK can instrument a selected node-postgres `Client` or `Pool` and correlate its queries with logs and exceptions captured in the same request. Enable instrumentation once per target and wrap request handlers with `client.withTrace`. Jekimo does not patch global prototypes, inspect HTTP requests, or install framework middleware automatically.

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
await jekimo.withTrace({ name: "GET /invoices/:id" }, async ({ traceId }) => {
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

The emitted context uses `trace_id`, `span_id`, optional `parent_span_id`, and `trace_name`. Database records receive their own span ID beneath the active scope. There is no separate root-span record or root-request duration. Async tasks created inside a scope can retain its context after the handler returns; wrap independent background work in a new explicit trace when it should not belong to that request. Scope fields take precedence over manually supplied correlation context. `captureContext: false` and configured context-key redaction still apply.

## PostgreSQL adapter scope

The integration supports standard promise and callback forms of `query` on the selected target, including ordinary query-config objects. It preserves the query receiver, argument objects, result objects, and original errors. Callback receivers and return values are preserved, and delayed callbacks run in the originating request context. Promise queries return a chained promise that preserves their resolution/rejection, not necessarily the original promise object's identity.

It does not read SQL, parameters, rows, connection strings, or database error messages. Every call through that target uses the static configured name (default `postgres.query`) and operation (default `other`). You may supply an explicit static `operation` such as `select`; the adapter does not infer it by parsing SQL. Keep `traceQuery` for places that need a distinct per-operation name.

Supported and excluded paths:

- `pool.query(...)` and `client.query(...)`: instrument the instance whose method the application calls.
- `pool.connect()` clients: not automatically instrumented. Instrument a checked-out client separately and restore it **before returning it to the pool**.
- Do not instrument both a pool and its internal/checked-out clients at the same time, or wrap an already instrumented call with `traceQuery`; that can produce two measurements.
- Query/Submittable objects, cursors, streams, and config objects containing a `callback` property: passed through without instrumentation. Use standard callback arguments or explicit duration reporting for these paths.
- Instrumentation is explicit; Prisma, Sequelize, TypeORM, and other ORM hooks are not included.

The handle reports `installed`. Reinstalling with the same SDK client returns the existing handle; a different client cannot take over an instrumented target. Frozen/non-configurable targets return an uninstalled handle. `restore()` stops future instrumentation and restores the original property when it still owns the wrapper, preserving wrappers installed afterward. Queries already in flight may still report their completion. Reporting failures do not replace database results or errors. Monitoring retains the SDK's existing bounded queue and asynchronous delivery; disabled or closed clients pass calls through without collecting new timings.

## Trace view and API

Open **Traces**, enter a trace ID, and choose the last 24 hours or seven days. Or follow **View request trace** from a database call, log/custom-event detail, or an issue's latest event. Those links use a two-day receipt window centered on the selected record, so older retained requests remain discoverable.

The page combines all event kinds and database calls, newest received first, with cursor pagination. Query durations and statuses are shown alongside messages, service, environment, and expandable record details. It is a correlation view, not a complete distributed trace or timing waterfall. Sampling, redaction, retention, and delivery loss may remove records. A scope with no captured events will not appear.

`GET /api/v1/projects/:id/events?trace_id=<id>` filters existing event queries by exact trace ID. It uses the normal session and `project.read` check, receipt-time filters, and cursor pagination. Other filters can be combined, or omitted to include all kinds. Malformed, uppercase, and all-zero IDs return 400. The server never looks up another project's records, even when two projects use the same trace ID. Context values outside this ID format remain permitted by the envelope but cannot be searched through this filter.

## Remaining work

Automatic framework lifecycle hooks, HTTP span timing, trace-wide sampling, automatic header propagation, distributed waterfalls, and ORM-specific instrumentation remain future work. Query notifications continue to use the existing per-call slow-query rules.

API references used for the adapter: [node-postgres queries](https://node-postgres.com/features/queries), [node-postgres Client](https://node-postgres.com/apis/client), and [Node asynchronous context tracking](https://nodejs.org/api/async_context.html).
