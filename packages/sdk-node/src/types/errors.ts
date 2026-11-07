import type { ValidationIssue } from "./event.js";

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
