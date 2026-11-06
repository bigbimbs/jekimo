# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- First vertical slice from instance setup to a stored, queryable event. See `docs/local-development.md`.
  - `packages/storage-postgres`: `pg` connection module reading `DATABASE_URL`, a plain-SQL migration runner (`npm run migrate`), metadata tables, an `events` table partitioned by UTC day of `received_at` with a 7-day `event_ids` deduplication index, and a `queue_jobs` table. Exposes `PostgresMetadataRepository`, `PostgresEventStore` (`appendEvents`, `queryEvents`, `expireDay`, and an `archiveDay` stub for Phase 2), and `PostgresQueue` (`FOR UPDATE SKIP LOCKED`, visibility timeout, bounded retries with backoff, dead-letter state). Project data is only reachable through a `ProjectAccess` issued after a membership check.
  - `apps/api` (Fastify): `GET /healthz`; one-time setup with a console token that creates the first instance admin (Argon2id); session sign-in and sign-out with `HttpOnly`, `Secure`, `SameSite=Lax` cookies, idle and absolute expiry, lockout, and a CSRF header; `POST` and `GET /api/v1/projects`; `POST /api/v1/projects/:id/keys`, which returns a `jk_` key once, stores only its SHA-256, and audit-logs the `key_id`; `POST /api/v1/ingest` per ingestion protocol v1 with constant-time key checks, content-type, gzip, and 1 MiB limits; and `GET /api/v1/projects/:id/events` by time range and severity. Ingestion keys are rejected on every other route and sessions cannot reach ingest. Rate limits are not implemented yet.
  - `apps/worker`: drains the queue, applies project sampling, re-applies default redaction, derives fingerprints, appends events idempotently, keeps issue summaries with counts derived from the event store, and runs the expiry pass every 15 minutes.
  - `deploy/docker-compose/docker-compose.dev.yml`, `Dockerfile`s for `apps/api` and `apps/worker`, `.env.example`, and `docs/local-development.md`. `docs/configuration.md` lists every implemented variable.
  - CI runs the PostgreSQL integration tests against a service container and builds the apps.

- Storage engine guidance in `docs/architecture.md`: why PostgreSQL is the hot store for the first release, how the event tables must be built, where its limits are, and five binding design rules that keep the event store replaceable so ClickHouse can be offered as an opt-in event store in Phase 2.
- Object storage specification in `docs/object-storage.md`: an optional S3-compatible boundary (Cloudflare R2, S3, Backblaze B2, MinIO, local filesystem) used as a cold tier with hot and cold retention, per-project key layout, archive format and manifest, restores, disk safety with archiving, backups, exports, security rules, and configuration. `packages/event-schema` gains `archiveDayPrefix`, `archivePartKey`, `archiveManifestKey`, `parseArchiveKey`, and `splitRetention`, with tests. `docs/backups-and-restore.md` now states what backups contain and where they go.
- Retention specification in `docs/retention.md`: per-project retention measured from receipt, expiry mechanics, quotas, deterministic sampling that never drops exceptions or errors, disk-pressure levels with emergency expiry and ingestion refusal, deletion semantics, and proposed first-release sizing. `packages/event-schema` gains `RETENTION` and `DISK_THRESHOLDS` constants, `normalizeRetentionDays`, `isExpired`, `diskLevel`, `effectiveRetentionDays`, and `shouldKeepEvent`, with tests.
- Access model specification in `docs/access-model.md`: instance roles, a permission catalogue for projects with built-in `admin`, `member`, and `viewer` roles and custom roles under a no-escalation rule, password and session rules, invitations and recovery without email, authorization enforcement rules, audit log, and setup flow. `PROJECT_PERMISSIONS`, `DEFAULT_PROJECT_ROLES`, `validateCustomRole`, and `canAssignRole` encode the permission model; a test checks them against the table in the access model document.
- Ingestion protocol v1 contract: normative spec in `docs/ingestion-protocol.md` covering the endpoint, bearer ingestion keys, batching, limits, clock skew, deduplication, 202 and error responses, rate limits, and SDK retry rules. `packages/event-schema` gains the request and response types, `parseIngestionKey`, `bearerToken`, and `validateIngestRequest`, with tests.
- Event envelope v1 contract: normative spec in `docs/event-format.md`, published JSON Schema, zero-dependency reference validator (`validateEvent`) with ingest and stored modes, default redaction key list, example payloads, and a test suite that keeps spec, schema, and validator in agreement.
- Test tooling: Vitest with `npm test`, run in CI alongside the type check.
- Repository scaffold: monorepo layout, product brief, contributor documentation, issue and pull request templates, and CI workflow.
- Apache License 2.0.

[Unreleased]: https://github.com/bigbimbs/jekimo/commits/main
