// These mirror packages/event-schema/src/types.ts instead of importing it:
// @jekimo/event-schema is bundled into the JavaScript build and is not
// published, so the emitted declarations must not reference it.
// test/package.test.ts checks that the two stay in agreement.

export type EventKind = "exception" | "log" | "event";
export type Severity = "debug" | "info" | "warning" | "error" | "fatal";

/** A JSON value permitted inside `attributes`. */
export type AttributeValue = string | number | boolean | null | AttributeValue[] | { [key: string]: AttributeValue };

export interface ExceptionInfo {
  type: string;
  value?: string;
  stacktrace?: string;
}

/** Event envelope v1 in ingest form (no `project_id`). See docs/event-format.md. */
export interface EventEnvelope {
  schema_version: 1;
  event_id: string;
  timestamp: string;
  kind: EventKind;
  severity: Severity;
  message: string;
  service?: string;
  environment?: string;
  release?: string;
  fingerprint?: string;
  exception?: ExceptionInfo;
  sdk?: { name: string; version: string };
  context?: Record<string, string>;
  attributes?: Record<string, AttributeValue>;
}

/** One validation issue, as returned by the event validator and the ingestion API. */
export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

/** Input to captureEvent: any envelope fields; the SDK fills in the rest. */
export interface PartialEnvelope {
  message: string;
  kind?: EventKind;
  severity?: Severity;
  timestamp?: string | Date;
  service?: string;
  environment?: string;
  release?: string;
  fingerprint?: string;
  exception?: ExceptionInfo;
  context?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}
