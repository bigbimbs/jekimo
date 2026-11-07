import type { EventEnvelope } from "./envelope.js";
import type { ValidationIssue } from "./validate.js";

export interface ParsedIngestionKey {
  /** Public identifier, safe to log and display. */
  keyId: string;
  /** Never log, store, or display this. */
  secret: string;
}

export interface IngestRequest {
  /** RFC 3339 time the SDK sent the request, by the client's clock. */
  sent_at?: string;
  /** 1 to LIMITS.MAX_BATCH_EVENTS envelopes in ingest form. */
  events: EventEnvelope[];
}

export interface IngestRejection {
  /** Position in the request `events` array. */
  index: number;
  /** The event's id when one could be read from the payload. */
  event_id?: string;
  errors: ValidationIssue[];
}

export interface IngestWarning extends ValidationIssue {
  index: number;
}

/** Body of a 202 response. */
export interface IngestResponse {
  /**
   * Queued event_ids, once each. Repeats of events accepted by an earlier
   * request are listed too; the event store drops them at append.
   */
  accepted: string[];
  rejected: IngestRejection[];
  warnings?: IngestWarning[];
}

export type IngestErrorCode =
  | "invalid_json"
  | "invalid_request"
  | "too_many_events"
  | "unauthorized"
  | "project_disabled"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "quota_exceeded"
  | "unavailable";

/** Body of every non-202 response. */
export interface IngestErrorResponse {
  error: {
    code: IngestErrorCode;
    message: string;
    /** Seconds; present for rate_limited, quota_exceeded, and unavailable. */
    retry_after?: number;
  };
}

export interface ValidateIngestRequestOptions {
  /** Server time. Defaults to the current time. */
  now?: Date;
  /** Decompressed body size in bytes, when known, for the payload limit. */
  bodyBytes?: number;
  maxEvents?: number;
  maxBodyBytes?: number;
}

export interface AcceptedEvent {
  index: number;
  event: EventEnvelope;
}

export type IngestRequestResult =
  | {
      ok: true;
      /**
       * Events to enqueue, one per unique event_id, in request order. Not
       * checked against earlier requests; the event store dedupes at append.
       */
      accepted: AcceptedEvent[];
      /** Indices of events that repeated an earlier event_id in this request. */
      duplicates: number[];
      rejected: IngestRejection[];
      warnings: IngestWarning[];
      /** Client clock minus server clock in milliseconds, when sent_at was usable. */
      skewMs?: number;
      /** The 202 response body for this result. */
      response: IngestResponse;
    }
  | { ok: false; status: number; response: IngestErrorResponse };
