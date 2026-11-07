/**
 * Versioned event envelope shared by Jekimo services and SDKs.
 *
 * The normative description lives in docs/event-format.md. The JSON Schema
 * in schema/event-envelope.v1.json and the validator in validate.ts must stay
 * in agreement with it; the test suite checks that they do.
 */

/** Current envelope schema version. Incremented only on breaking changes. */
export const SCHEMA_VERSION = 1 as const;

export const EVENT_KINDS = ["exception", "log", "event"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const SEVERITIES = ["debug", "info", "warning", "error", "fatal"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Crockford base32 ULID: 26 characters, first character 0-7. */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** RFC 3339 timestamp with optional fractional seconds and a Z or numeric offset. */
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export interface ExceptionInfo {
  /** Exception class or type name, for example "DatabaseError". */
  type: string;
  /** The exception's own message, distinct from the envelope `message`. */
  value?: string;
  /** Raw stack trace text as captured by the SDK. */
  stacktrace?: string;
}

export interface SdkInfo {
  /** SDK package name, for example "@jekimo/sdk-node". */
  name: string;
  /** SDK package version. */
  version: string;
}

/** A JSON value permitted inside `attributes`. */
export type AttributeValue = string | number | boolean | null | AttributeValue[] | { [key: string]: AttributeValue };

export interface EventEnvelope {
  schema_version: typeof SCHEMA_VERSION;
  /** Client-generated ULID. Unique per project; the server deduplicates on it. */
  event_id: string;
  /**
   * Set by the server from the ingestion key. Present on stored and exported
   * events. Clients must not send it; the ingestion API rejects it.
   */
  project_id?: string;
  /** RFC 3339 timestamp of when the event occurred. UTC (`Z`) recommended. */
  timestamp: string;
  kind: EventKind;
  severity: Severity;
  /** Human-readable summary. Required and non-empty. */
  message: string;
  /** Logical service or application name. */
  service?: string;
  /** Deployment environment, for example "production" or "staging". */
  environment?: string;
  /** Release or version identifier of the reporting application. */
  release?: string;
  /** Stable grouping key. When absent the worker derives one. */
  fingerprint?: string;
  /** Required when `kind` is "exception". */
  exception?: ExceptionInfo;
  /** Reporting SDK identity. */
  sdk?: SdkInfo;
  /** Correlation identifiers: request_id, trace_id, span_id, and similar. */
  context?: Record<string, string>;
  /** Free-form structured data, subject to redaction and size limits. */
  attributes?: Record<string, AttributeValue>;
}
