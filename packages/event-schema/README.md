# Event schema

This package holds the versioned event envelope shared by Jekimo services and SDKs. `src/index.ts` currently contains the draft TypeScript types for the envelope described in the project README.

Changes to the public event contract must be versioned and documented in [`docs/event-format.md`](../../docs/event-format.md).

Validation, serialization helpers, and a published JSON Schema are not implemented yet.
