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

### Designed for ClickHouse from day one

ClickHouse is the strongest engine for high-volume structured logs and events: columnar, 10 to 20 times compression, fast aggregations, native S3 backup and S3-backed storage tiers. It runs on a single VPS, but it raises the realistic minimum to 8 GB of RAM and adds a second database with its own backups, upgrades, and credentials, and it has no transactions. Those are the reasons it is not the MVP default for a product whose first promise is a simple install on a small VPS.

So the first release ships PostgreSQL only, and the design treats the **event store** as replaceable from the start. These rules are binding on `apps/api`, `apps/worker`, and `packages/storage-postgres`:

1. **Two stores, one boundary.** Users, projects, memberships, settings, ingestion keys, issue state, counters, and the audit log are *metadata* and always live in PostgreSQL. Event rows are the *event store* behind a separate interface with project-scoped operations (`appendEvents`, `queryEvents`, `expireDay`, `archiveDay`), never raw SQL.
2. **Idempotent appends keyed on `event_id`.** The worker writes events so that a retry produces no duplicate on either engine: a unique index in PostgreSQL, a `ReplacingMergeTree` on `(project_id, event_id)` in ClickHouse. Nothing may depend on an insert failing to detect a duplicate.
3. **No transaction spans the two stores.** Accepting an event, updating its issue, and incrementing counters are separate idempotent steps with the event store written first. Issue counts are derived from the event store and may be recomputed; they are never the source of truth.
4. **No engine-specific features in the query API contract.** Search, filters, and aggregations are expressed in the boundary's terms. If a capability is cheap in one engine and expensive in another (full-text ranking, exact distinct counts), the contract names it as optional and the dashboard degrades.
5. **The event store schema is the envelope plus server metadata**, flat enough to map to a columnar table without reshaping.

With those rules, offering ClickHouse is an additional implementation of one interface plus an installer option, not a rewrite. It is planned as an opt-in event store for operators with high log volume in **Phase 2**, alongside the object storage cold tier. TimescaleDB (hypertables and columnar compression inside PostgreSQL) remains a lighter intermediate step for operators who want more headroom without a second system.

Engines considered and not chosen for the core: Elasticsearch and OpenSearch (best full-text search, heaviest operational footprint), Loki (cheap and object-storage native, weak at structured search), VictoriaLogs (lightweight and promising, still young).

## Deployment

Docker Compose will run the app on one VPS. Setup will connect an existing PostgreSQL datasource or provision PostgreSQL locally. Provisioning credentials are one-time setup secrets; runtime services use a restricted application account.

This document describes the intended design. A first vertical slice of the API, worker, and PostgreSQL storage follows it; [local-development.md](local-development.md) shows it running.
