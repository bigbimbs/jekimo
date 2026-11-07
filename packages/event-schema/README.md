# Event schema

The versioned event envelope shared by Jekimo SDKs, the ingestion API, the worker, storage, and exports. The normative specification is [`docs/event-format.md`](../../docs/event-format.md).

This package contains:

- `src/types/` — interfaces and type aliases, one file per domain (`envelope`, `validate`, `ingest`, `retention`, `archive`, `permissions`, `fingerprint`, `redact`). Types only, no runtime code.
- `src/constants/` — fixed values, one file per domain: the envelope version, kinds, severities, and patterns (`envelope`); size and cardinality limits (`limits`); the default redaction key list (`redact`); the ingest path, key pattern, and error status table (`ingest`); retention and disk-threshold defaults (`retention`); the cold-tier layout constants (`archive`); the permission catalogue and built-in roles (`permissions`); and the always-kept severities (`sampling`).
- `src/validate.ts` — `validateEvent(input, { mode })`, a zero-dependency reference validator that never throws, drops unknown fields with a warning, and distinguishes the `ingest` form (no `project_id`) from the `stored` form (`project_id` required).
- `src/ingest.ts` — ingestion protocol v1: `parseIngestionKey`, `bearerToken`, and `validateIngestRequest`, which applies batch limits, clock skew correction, in-request deduplication, and per-event validation. Normative text: [`docs/ingestion-protocol.md`](../../docs/ingestion-protocol.md).
- `src/retention.ts` — `normalizeRetentionDays`, `isExpired`, `diskLevel`, and `effectiveRetentionDays`. Normative text: [`docs/retention.md`](../../docs/retention.md).
- `src/fingerprint.ts` — `deriveFingerprint`, the grouping key the worker stores when an event has no `fingerprint`, with `stackFrames` and `normalizeMessage`. Normative text: [`docs/event-format.md`](../../docs/event-format.md), "Grouping".
- `src/redact.ts` — `redactEvent(event, { extraKeys, patterns, dropContext })`, which returns a copy with sensitive `context` and `attributes` values replaced by `[REDACTED]` at every depth, `createKeyRedactor` for code that redacts while copying values, and `isRedactedKey`/`normalizeKey` for the default key list. The Node SDK and the worker both use it. Normative text: [`docs/event-format.md`](../../docs/event-format.md), "Privacy defaults".
- `src/sampling.ts` — deterministic sampling from the event id: `ulidSampleFraction` and `shouldKeepEvent`, which never drops exceptions or error/fatal events.
- `src/permissions.ts` — `validateCustomRole` (naming, required permission, no-escalation) and `canAssignRole`. A test checks the built-in roles against the table in [`docs/access-model.md`](../../docs/access-model.md).
- `src/archive.ts` — cold-tier key layout (`archiveDayPrefix`, `archivePartKey`, `archiveManifestKey`, `parseArchiveKey`) and `splitRetention` for the hot/cold retention split. Normative text: [`docs/object-storage.md`](../../docs/object-storage.md).
- `src/index.ts` — the package entry point, which re-exports every public function, constant, and type.
- `schema/event-envelope.v1.json` — the published JSON Schema (draft 2020-12).
- `examples/` — valid example payloads used by the documentation and the tests.

## Getting the schema

Every GitHub release attaches the JSON Schema it shipped with as `event-envelope.v1.json`, byte-identical to the file in the tagged commit, with `event-envelope.v1.json.sha256` next to it in `sha256sum` format. The latest release's copy is always at <https://github.com/bigbimbs/jekimo/releases/latest/download/event-envelope.v1.json>; the copy for a specific version is under that version's release on the [releases page](https://github.com/bigbimbs/jekimo/releases). Prefer a release copy to the file on `main`, which changes whenever `main` does.

## Tests

The test suite checks that the validator, the JSON Schema, and the examples agree with each other. Any change to the contract must update all three and be recorded in `docs/event-format.md`.
