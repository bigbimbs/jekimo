# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Code tooling baseline: [Biome](https://biomejs.dev/) as the single linter and formatter (`biome.json`, `npm run lint`, `npm run lint:fix`, `npm run format`), with the repository formatted and `packages/event-schema` lint-clean. TypeScript now uses a shared `tsconfig.base.json` (adding `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`), a per-package `tsconfig.json`, and a solution-style root `tsconfig.json` checked with `tsc -b`. `npm run check` runs lint, type check, and tests, and CI runs them as separate steps. VS Code recommends the Biome extension.
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
