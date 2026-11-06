# Architecture

Jekimo is planned as a self-hosted, multi-project service. Its first implementation uses a Node.js and TypeScript API, a background event worker, a React and TypeScript dashboard, a Node.js SDK, and PostgreSQL storage.

## Event flow

```text
Node.js SDK -> authenticated API -> durable queue -> worker -> PostgreSQL (hot)
                                                   -> dashboard query API
                                                      PostgreSQL (hot) -> object store (cold, optional)
```

The event schema ([event-format.md](event-format.md)) and the ingestion protocol ([ingestion-protocol.md](ingestion-protocol.md)) are the public contracts shared across components. Every event, search, export, and issue action must be scoped to a project on the server; the rules are in [access-model.md](access-model.md). Project ingestion keys are separate from user sign-in credentials. Data lifetime, quotas, sampling, and disk safety are in [retention.md](retention.md); the optional S3-compatible cold tier, backups, and exports are in [object-storage.md](object-storage.md).

## Storage engines

PostgreSQL is the hot store for the first release, and the only engine the MVP supports. This section records why, where its limits are, and how the design keeps the door open.

### Why PostgreSQL first

- The first-release target is about 1,000,000 events a month, under 1,000 a minute at burst, with 30 days hot. PostgreSQL handles that on the reference 2 vCPU VPS without special tuning.
- One database means one backup, one restore drill, and one thing for a self-hosting operator to learn. Users, projects, memberships, issues, and events share transactions.
- Daily partitions keyed by `received_at` make expiry and archiving partition-level operations, which [retention.md](retention.md) and [object-storage.md](object-storage.md) depend on.

### How the event tables must be built

- Append-only. Events are inserted in batches by the worker (`COPY` or multi-row inserts) and never updated; issue state lives in separate rows.
- Partitioned by received day, with a BRIN index on `received_at`.
- A small set of b-tree indexes: `(project_id, received_at)`, `(project_id, fingerprint)`, and `(project_id, severity, received_at)`. Every index is paid for on every insert, so new ones need a query that justifies them.
- `message` indexed with a `tsvector` for search. `attributes` stored as JSONB **without** a GIN index until a real query needs one.
- Event rows hold only the envelope and server metadata. Issue summaries, counters, and project settings live in their own tables, so the event store can be swapped without touching them.

### Where PostgreSQL stops being comfortable

Around 5 to 10 million events a day on one instance, or hot retention beyond about 90 days. The symptoms are index write amplification, JSONB bloat, and aggregations over hundreds of millions of rows taking seconds. Full-text search quality is adequate, not excellent. The optional cold tier covers the long-retention case, which is the more common reason to outgrow PostgreSQL early.

### Upgrade path

The storage boundary in `packages/storage-postgres` exposes project-scoped operations, not SQL, and the query API contract must not depend on PostgreSQL-specific behavior. That allows two steps when an operator outgrows plain PostgreSQL:

1. **TimescaleDB.** A PostgreSQL extension that adds hypertables and columnar compression, cutting event storage by roughly 90% while keeping one database and one backup. This is a migration, not a new system, and is the first upgrade to offer.
2. **ClickHouse as an optional high-volume event store.** Columnar, 10 to 20 times compression, fast aggregations; the engine behind Sentry, SigNoz, HyperDX, and PostHog. Only the event store moves; users, projects, issues, and the audit log stay in PostgreSQL. The cost is a second system to operate, which is why it is optional and not before Phase 3.

Engines considered and not chosen for the core: Elasticsearch and OpenSearch (best full-text search, heaviest operational footprint), Loki (cheap and object-storage native, weak at structured search), VictoriaLogs (lightweight and promising, still young).

## Deployment

Docker Compose will run the app on one VPS. Setup will connect an existing PostgreSQL datasource or provision PostgreSQL locally. Provisioning credentials are one-time setup secrets; runtime services use a restricted application account.

This document describes the intended design; implementation has not started.
