# Retention, sampling, and disk safety

This document specifies how long a Jekimo instance keeps data, how operators bound the volume one project can store, and what happens when the VPS runs low on disk. It describes an instance **without** object storage; [object-storage.md](object-storage.md) extends it with a cold tier, longer retention, and archive-instead-of-delete behavior when a bucket is configured. It is normative for the worker, the storage layer, the ingestion API, and the dashboard. Reference constants and helpers live in `packages/event-schema/src/retention.ts` and `src/sampling.ts`.

Key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as in RFC 2119.

Status: draft.

## Goals

- One noisy project cannot exhaust the disk or starve the others.
- Operators can predict how much storage a configuration needs.
- Data leaves the system on a schedule the operator chose, without manual work.
- Expiry is cheap, so it runs continuously rather than in a risky weekly purge.

## What is retained

| Data | Scoped to | Retention |
| --- | --- | --- |
| Events (envelope plus server metadata) | Project | Project retention period |
| Issues (groups of events by fingerprint) | Project | Deleted when their last event expires |
| Project daily counters (accepted, rejected, dropped, sampled) | Project | 13 months |
| Audit log | Instance | 12 months, operator-adjustable |
| Deduplication index of accepted `event_id`s | Project | 7 days |
| Users, projects, memberships, settings, key hashes | Instance | Until deleted |

Server metadata stored with every event: `project_id`, `received_at`, `key_id` of the ingestion key that sent it, and `skew_ms` when the client supplied `sent_at`.

## Project retention period

Every project has a retention period in whole days.

| Setting | Value |
| --- | --- |
| Default for new projects | 30 days |
| Minimum | 1 day |
| Maximum | 3,650 days, and the operator MAY lower this instance-wide (`JEKIMO_RETENTION_MAX_DAYS`) |

- Retention is measured from `received_at`, the server time at ingestion, **not** from the event's own `timestamp`. A client with a wrong clock therefore does not cause instant expiry or indefinite retention. An event expires at `received_at + retention_days`.
- Project admins can change the period. Lowering it takes effect at the next expiry pass; data older than the new period is deleted then. The dashboard MUST say so before the change is saved.
- The instance operator MAY set a default (`JEKIMO_RETENTION_DEFAULT_DAYS`) that new projects inherit.

## Expiry mechanics

- The worker runs an expiry pass at least every 15 minutes.
- Event storage is partitioned by `received_at` day. Expiring a whole day for a project is a partition-level delete or drop, not a row-by-row scan. This is the main reason the partition key is `received_at` rather than `timestamp`.
- After events expire, issues with no remaining events are deleted, and project counters are updated. Resolved or ignored state on an issue is lost with the issue.
- Expiry MUST be idempotent and safe to interrupt. A crashed pass leaves no half-deleted day visible to queries, because partitions are detached before they are dropped.
- Expired data is not recoverable from the instance. Operators who need longer history configure a cold tier ([object-storage.md](object-storage.md)), keep backups ([backups-and-restore.md](backups-and-restore.md)), or export per project before the period ends.

## Quotas

Rate limits (events per minute) are defined in the [ingestion protocol](ingestion-protocol.md). Quotas bound the total:

| Setting | Scope | Default |
| --- | --- | --- |
| `events_per_day` quota | Project | none |
| `storage_bytes` soft cap | Project | none |

- When a project reaches its daily event quota, ingestion returns `429 quota_exceeded` until midnight UTC. The project's dashboard shows a banner with the count dropped.
- When a project exceeds its storage soft cap, the dashboard shows a warning and the instance admin is notified. Ingestion continues; the cap exists to make the conversation happen before the disk does.
- Instance admins set quotas; project admins can see them but not raise them.

## Sampling

Sampling reduces volume by keeping a deterministic fraction of events. It is off by default.

- Each project has a `sample_rate` between 0 and 1, default 1 (keep everything).
- The decision is a pure function of `event_id`, so it is the same wherever it is evaluated. The last 8 characters of the ULID (40 random bits) are decoded to a fraction in [0, 1); the event is kept if that fraction is below `sample_rate`. The helper is `shouldKeepEvent` in `packages/event-schema/src/sampling.ts`.
- **Exceptions are never sampled**, and neither is any event with severity `error` or `fatal`. Sampling applies to `log` and `event` kinds at `debug`, `info`, and `warning`.
- The server applies the project's rate at ingestion. Sampled-out events are counted in the daily `sampled` counter and are **acknowledged as accepted** in the `202` response, since the SDK did nothing wrong and must not retry them.
- SDKs MAY apply the same rate locally to save bandwidth, using the same function, so client and server decisions agree.
- Adding an optional `sample_rate` field to the envelope so stored counts can be scaled up is an additive change tracked in the open questions of [event-format.md](event-format.md).

## Disk safety

The operator configures the data directory or database volume. The instance watches free space on it.

| Level | Default threshold | Behavior |
| --- | --- | --- |
| Warning | 20% free | Banner for instance admins. Audit log entry. |
| Critical | 10% free | Expiry runs every minute and retention is temporarily treated as `min(configured, 7 days)` for all projects, oldest days first, until back above the warning level. Admins are notified. |
| Full | 5% free | Ingestion returns `503 unavailable` with `Retry-After: 60`. Dashboard and export keep working so data can be moved out. |

- Thresholds are operator-configurable (`JEKIMO_DISK_WARN_PERCENT`, `JEKIMO_DISK_CRITICAL_PERCENT`, `JEKIMO_DISK_FULL_PERCENT`).
- Emergency expiry at the critical level is the one case where data is deleted before its configured retention. It is logged per project with the number of events removed, so the operator can see what happened. With a healthy object store configured, the instance archives those days instead of deleting them; see [object-storage.md](object-storage.md).
- Ingestion MUST fail closed when it cannot determine free space; it MUST NOT assume the disk is healthy.

## Deletion

| Request | Effect |
| --- | --- |
| Delete a project | All events, issues, counters, keys, and memberships for the project are removed. Audit log entries about the project are kept. Irreversible after a 7-day grace period in which an instance admin can restore it. |
| Delete an issue | The issue and all of its events are removed immediately. |
| Delete events matching a filter | Project admins can delete events by time range, `context` key value, or attribute value within a project. Intended for removing data about one subject on request. Runs asynchronously; progress is shown in the dashboard. |
| Revoke an ingestion key | Stops ingestion with that key. Does not delete events already stored. |

All deletions are recorded in the audit log with who, what, and when, but never with the content of what was deleted.

## Proposed targets for the first release

These numbers size the MVP. They are proposals; measurements during Phase 1 will adjust them.

| Target | Value |
| --- | --- |
| Reference VPS | 2 vCPU, 4 GB RAM, 80 GB SSD, PostgreSQL on the same host |
| Sustained volume | 1,000,000 accepted events per month across all projects |
| Burst | 1,000 events per minute per project (the default rate limit) |
| Default retention | 30 days |
| Average stored event | 4 KiB including indexes |
| Storage at target | About 4 GB of events at 30 days, leaving room for PostgreSQL overhead, backups staging, and growth |

The install guide MUST show how storage scales: `monthly events × average event size × (retention days ÷ 30)`, with a safety factor of 2.

## Planned configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEKIMO_RETENTION_DEFAULT_DAYS` | `30` | Retention for new projects |
| `JEKIMO_RETENTION_MAX_DAYS` | `3650` | Upper bound project admins can set |
| `JEKIMO_DISK_WARN_PERCENT` | `20` | Free space warning level |
| `JEKIMO_DISK_CRITICAL_PERCENT` | `10` | Emergency expiry level |
| `JEKIMO_DISK_FULL_PERCENT` | `5` | Ingestion refusal level |
| `JEKIMO_AUDIT_LOG_DAYS` | `365` | Audit log retention |

## Open questions

- Whether to offer per-kind retention (for example, keep exceptions longer than logs) in the first release or later.
- Whether emergency expiry should prefer projects over their soft storage cap before touching the others.
