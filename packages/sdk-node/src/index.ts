/**
 * Public entry point of @jekimo/sdk-node.
 *
 * Every public type is declared in this file so the emitted `index.d.ts` is
 * self-contained: `@jekimo/event-schema` is bundled into the JavaScript build
 * and is not a runtime or type dependency of the published package. The shapes
 * below mirror `packages/event-schema/src/types.ts`; test/types.test.ts keeps
 * them in agreement.
 */

import { Client } from "./client.js";
import { installUnhandledHandlers } from "./node.js";
import { NAME, VERSION } from "./version.js";

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

/** Request passed to the transport. Global `fetch` accepts it as `RequestInit`. */
export interface TransportRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string | Uint8Array;
  signal: AbortSignal;
  redirect: "manual";
}

/** The parts of a `fetch` Response the SDK reads. */
export interface TransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** A `fetch`-compatible function. Defaults to the global `fetch`. */
export type Transport = (url: string, request: TransportRequest) => Promise<TransportResponse>;

export type JekimoErrorCode =
  /** The options passed to `init` are unusable; the client is disabled. */
  | "invalid_config"
  /** `baseUrl` uses plain HTTP on a host other than loopback. */
  | "insecure_transport"
  /** An event failed validation after normalisation and was dropped. */
  | "invalid_event"
  /** The server accepted the request but rejected this event (202 `rejected`). */
  | "event_rejected"
  /** The server refused the request with a non-retryable status. The batch was dropped. */
  | "request_failed"
  /** A batch failed with a retryable error on every attempt and was dropped. */
  | "retries_exhausted";

/** Passed to `onError`. Never contains the ingestion key. */
export interface JekimoError {
  code: JekimoErrorCode;
  message: string;
  /** HTTP status, for request-level failures. */
  status?: number;
  /** Request-level error code from the response body, when the server sent one. */
  serverCode?: string;
  /** The event concerned, for `invalid_event` and `event_rejected`. */
  eventId?: string;
  /** Validation issues, for `invalid_event` and `event_rejected`. */
  issues?: ValidationIssue[];
}

export type DropReason =
  /** The queue was full; the oldest event was dropped to make room. */
  | "queue_full"
  /** The event failed validation. */
  | "invalid_event"
  /** The server refused the request with a non-retryable status. */
  | "request_failed"
  /** Every retry attempt failed. */
  | "retries_exhausted"
  /** The client closed or the process exited before the events were sent. */
  | "shutdown";

export interface DropInfo {
  reason: DropReason;
  /** Number of events dropped. */
  count: number;
}

export interface JekimoOptions {
  /**
   * Connection string `https://<ingestion key>@<host>[/path]`. The key is
   * moved into the `Authorization` header and never sent in the URL. Use this
   * or `baseUrl` with `ingestionKey`.
   */
  dsn?: string;
  /** Instance address, for example `https://jekimo.example.com`. */
  baseUrl?: string;
  /** Project ingestion key, `jk_<key_id>_<secret>`. */
  ingestionKey?: string;
  service?: string;
  environment?: string;
  release?: string;
  /** Context entries added to every event, for example `{ host: "api-1" }`. */
  context?: Record<string, string>;
  /** Set false to send no `context` at all. Default true. */
  captureContext?: boolean;
  /**
   * Local sampling for `log` and `event` kinds at debug, info, and warning.
   * Exceptions and error or fatal events are always sent. Default 1.
   */
  sampleRate?: number;
  /** Keys redacted in addition to the default list, compared like the defaults. */
  redactKeys?: string[];
  /** Keys matching any of these expressions are redacted too. */
  redactPatterns?: RegExp[];
  /** Maximum events held in memory. The oldest is dropped when full. Default 1,000. */
  maxQueueSize?: number;
  /** Send queued events at least this often, in milliseconds. Default 2,000. */
  flushIntervalMs?: number;
  /** Send when this many events are queued, and at most this many per request. Default and maximum 100. */
  maxBatchEvents?: number;
  /** Send when this many bytes of serialised events are queued, and at most this many per request. Default 512 KiB. */
  maxBatchBytes?: number;
  /** How long the process-exit flush and `close()` may wait, in milliseconds. Default 2,000. */
  shutdownTimeoutMs?: number;
  /** Flush on natural process exit (`beforeExit`). Default true. */
  flushOnExit?: boolean;
  /** Replaces the global `fetch`, for tests or custom agents. */
  transport?: Transport;
  /** Called for failures. Defaults to a one-line `console.warn`. */
  onError?: (error: JekimoError) => void;
  /** Called whenever events are dropped. */
  onDrop?: (info: DropInfo) => void;
  /** `true` logs SDK activity with `console.debug`; a function receives each line instead. */
  debug?: boolean | ((line: string) => void);
}

/** Per-call options for captureException, captureMessage, and log. */
export interface CaptureOptions {
  /** Overrides the default severity. */
  severity?: Severity;
  /** Overrides the derived message. */
  message?: string;
  fingerprint?: string;
  context?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
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

export interface ClientStats {
  /** Events waiting in the queue. */
  queued: number;
  /** Events the server acknowledged as accepted. */
  sent: number;
  /** Events the server rejected in a 202 response. */
  rejected: number;
  /** Events dropped locally, for any `DropReason`. */
  dropped: number;
}

export interface JekimoClient {
  /** False when the configuration was unusable or after `close()`. */
  readonly enabled: boolean;
  /** Captures an error as a `kind: "exception"` event. Returns the event id, or undefined if not queued. */
  captureException(error: unknown, options?: CaptureOptions): string | undefined;
  /** Captures a message as a `kind: "event"` event. Default severity `info`. */
  captureMessage(message: string, severity?: Severity, options?: CaptureOptions): string | undefined;
  /** Records a `kind: "log"` event. */
  log(severity: Severity, message: string, attributes?: Record<string, unknown>): string | undefined;
  /** Captures a custom envelope. Defaults: kind `event`, severity `info`. */
  captureEvent(event: PartialEnvelope): string | undefined;
  /** Sends everything queued. Resolves true when drained, false on timeout (default `shutdownTimeoutMs`). */
  flush(timeoutMs?: number): Promise<boolean>;
  /** Flushes within the timeout, then stops the client and drops anything left. */
  close(timeoutMs?: number): Promise<boolean>;
  stats(): ClientStats;
}

export const SDK_NAME: string = NAME;
export const SDK_VERSION: string = VERSION;

let current: JekimoClient | undefined;

/** Creates a client and makes it the target of the top-level capture functions. */
export function init(options: JekimoOptions): JekimoClient {
  current = new Client(options);
  return current;
}

/** The client created by the most recent `init`, if any. */
export function getClient(): JekimoClient | undefined {
  return current;
}

export function captureException(error: unknown, options?: CaptureOptions): string | undefined {
  return current?.captureException(error, options);
}

export function captureMessage(message: string, severity?: Severity, options?: CaptureOptions): string | undefined {
  return current?.captureMessage(message, severity, options);
}

export function log(severity: Severity, message: string, attributes?: Record<string, unknown>): string | undefined {
  return current?.log(severity, message, attributes);
}

export function captureEvent(event: PartialEnvelope): string | undefined {
  return current?.captureEvent(event);
}

export function flush(timeoutMs?: number): Promise<boolean> {
  return current ? current.flush(timeoutMs) : Promise.resolve(true);
}

export function close(timeoutMs?: number): Promise<boolean> {
  return current ? current.close(timeoutMs) : Promise.resolve(true);
}

export interface CaptureUnhandledOptions {
  /** Defaults to the client from the most recent `init`. */
  client?: JekimoClient;
  /** How long to wait for delivery before the process crashes, in milliseconds. Default 2,000. */
  timeoutMs?: number;
}

/**
 * Reports `uncaughtException` and `unhandledRejection` as fatal exceptions
 * without changing what Node does with them: when no other handler is
 * installed the process still crashes with the original error, after a
 * bounded wait for delivery. Returns a function that removes the handlers.
 */
export function captureUnhandled(options: CaptureUnhandledOptions = {}): () => void {
  return installUnhandledHandlers(() => options.client ?? current, options.timeoutMs ?? 2000);
}
