/**
 * Versioned event envelope shared by Jekimo services and SDKs.
 *
 * This mirrors the "Proposed event envelope" in the project README. It is a
 * draft contract: fields may change until the first stable release, and every
 * change must be recorded in docs/event-format.md.
 */

/** Current envelope schema version. Increment on breaking changes. */
export const SCHEMA_VERSION = 1 as const;

export type EventKind = "exception" | "log" | "event";

export type Severity = "debug" | "info" | "warning" | "error" | "fatal";

export interface ExceptionInfo {
  /** Exception class or type name, for example "DatabaseError". */
  type: string;
  /** Raw stack trace text as captured by the SDK. */
  stacktrace?: string;
}

export interface EventEnvelope {
  schema_version: typeof SCHEMA_VERSION;
  /** Client-generated, time-sortable identifier (ULID recommended). */
  event_id: string;
  /** Assigned by the server from the ingestion key; clients must not choose it. */
  project_id: string;
  /** ISO 8601 timestamp in UTC. */
  timestamp: string;
  kind: EventKind;
  severity: Severity;
  message: string;
  service?: string;
  environment?: string;
  release?: string;
  /** Stable grouping key; the worker derives one when absent. */
  fingerprint?: string;
  exception?: ExceptionInfo;
  /** Request, trace, and other correlation identifiers. */
  context?: Record<string, string>;
  /** Free-form, redaction-subject attributes. */
  attributes?: Record<string, unknown>;
}
