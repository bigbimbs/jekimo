import type { DropInfo, JekimoError } from "./errors.js";
import type { PartialEnvelope, Severity } from "./event.js";
import type { Transport } from "./transport.js";

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
