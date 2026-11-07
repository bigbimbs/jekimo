# Event schema

The versioned event envelope shared by Jekimo SDKs, the ingestion API, the worker, storage, and exports. The normative specification is [`docs/event-format.md`](../../docs/event-format.md).

This package contains:

- `src/types.ts` — TypeScript types and constants for envelope v1.
- `src/limits.ts` — size and cardinality limits, and the default redaction key list.
- `src/validate.ts` — `validateEvent(input, { mode })`, a zero-dependency reference validator that never throws, drops unknown fields with a warning, and distinguishes the `ingest` form (no `project_id`) from the `stored` form (`project_id` required).
- `src/ingest.ts` — ingestion protocol v1: request and response types, `parseIngestionKey`, `bearerToken`, the error code to HTTP status table, and `validateIngestRequest`, which applies batch limits, clock skew correction, in-request deduplication, and per-event validation. Normative text: [`docs/ingestion-protocol.md`](../../docs/ingestion-protocol.md).
- `src/retention.ts` — retention and disk-threshold constants, `normalizeRetentionDays`, `isExpired`, `diskLevel`, and `effectiveRetentionDays`. Normative text: [`docs/retention.md`](../../docs/retention.md).
- `src/fingerprint.ts` — `deriveFingerprint`, the grouping key the worker stores when an event has no `fingerprint`, with `stackFrames` and `normalizeMessage`. Normative text: [`docs/event-format.md`](../../docs/event-format.md), "Grouping".
- `src/redact.ts` — `redactEvent(event, { extraKeys, patterns, dropContext })`, which returns a copy with sensitive `context` and `attributes` values replaced by `[REDACTED]` at every depth, and `createKeyRedactor` for code that redacts while copying values. The Node SDK and the worker both use it. Normative text: [`docs/event-format.md`](../../docs/event-format.md), "Privacy defaults".
- `src/sampling.ts` — deterministic sampling from the event id: `ulidSampleFraction` and `shouldKeepEvent`, which never drops exceptions or error/fatal events.
- `src/permissions.ts` — the project permission catalogue, built-in role definitions, `validateCustomRole` (naming, required permission, no-escalation), and `canAssignRole`. A test checks the built-in roles against the table in [`docs/access-model.md`](../../docs/access-model.md).
- `src/archive.ts` — cold-tier key layout (`archiveDayPrefix`, `archivePartKey`, `archiveManifestKey`, `parseArchiveKey`) and `splitRetention` for the hot/cold retention split. Normative text: [`docs/object-storage.md`](../../docs/object-storage.md).
- `schema/event-envelope.v1.json` — the published JSON Schema (draft 2020-12).
- `examples/` — valid example payloads used by the documentation and the tests.

The test suite checks that the validator, the JSON Schema, and the examples agree with each other. Any change to the contract must update all three and be recorded in `docs/event-format.md`.
