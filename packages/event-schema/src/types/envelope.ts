// Envelope v1. Normative text: docs/event-format.md. The JSON Schema in
// schema/event-envelope.v1.json and the validator must agree with it; the
// tests check that they do.

import type { EventKind, SCHEMA_VERSION, Severity } from "../constants/envelope.js";

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
  /** Human-readable summary; must be non-empty. */
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
  sdk?: SdkInfo;
  /** Correlation identifiers: request_id, trace_id, span_id, and similar. */
  context?: Record<string, string>;
  /** Free-form structured data, subject to redaction and size limits. */
  attributes?: Record<string, AttributeValue>;
}
