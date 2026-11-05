# Event schema

The versioned event envelope shared by Jekimo SDKs, the ingestion API, the worker, storage, and exports. The normative specification is [`docs/event-format.md`](../../docs/event-format.md).

This package contains:

- `src/types.ts` — TypeScript types and constants for envelope v1.
- `src/limits.ts` — size and cardinality limits, and the default redaction key list.
- `src/validate.ts` — `validateEvent(input, { mode })`, a zero-dependency reference validator that never throws, drops unknown fields with a warning, and distinguishes the `ingest` form (no `project_id`) from the `stored` form (`project_id` required).
- `src/ingest.ts` — ingestion protocol v1: request and response types, `parseIngestionKey`, `bearerToken`, the error code to HTTP status table, and `validateIngestRequest`, which applies batch limits, clock skew correction, in-request deduplication, and per-event validation. Normative text: [`docs/ingestion-protocol.md`](../../docs/ingestion-protocol.md).
- `schema/event-envelope.v1.json` — the published JSON Schema (draft 2020-12).
- `examples/` — valid example payloads used by the documentation and the tests.

The test suite checks that the validator, the JSON Schema, and the examples agree with each other. Any change to the contract must update all three and be recorded in `docs/event-format.md`.
