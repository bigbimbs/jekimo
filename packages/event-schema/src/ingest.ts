/**
 * Ingestion protocol v1: request and response shapes, ingestion key parsing,
 * and request-level validation. Normative text: docs/ingestion-protocol.md.
 */

import { LIMITS } from "./limits.js";
import { type EventEnvelope, TIMESTAMP_PATTERN } from "./types.js";
import { type ValidationIssue, validateEvent } from "./validate.js";

export const INGEST_PATH = "/api/v1/ingest" as const;

/** `jk_<key_id:12 Crockford base32>_<secret:32 [a-z0-9]>` */
export const INGESTION_KEY_PATTERN = /^jk_([0-9A-HJKMNP-TV-Z]{12})_([a-z0-9]{32})$/;

export interface ParsedIngestionKey {
  /** Public identifier, safe to log and display. */
  keyId: string;
  /** Never log, store, or display this. */
  secret: string;
}

/** Parses an ingestion key. Returns null for anything that is not well-formed. */
export function parseIngestionKey(value: unknown): ParsedIngestionKey | null {
  if (typeof value !== "string") return null;
  const m = INGESTION_KEY_PATTERN.exec(value);
  if (!m) return null;
  return { keyId: m[1]!, secret: m[2]! };
}

/** Extracts the bearer token from an Authorization header value, or null. */
export function bearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
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

/** HTTP status for each request-level error code. */
export const INGEST_ERROR_STATUS: Record<IngestErrorCode, number> = {
  invalid_json: 400,
  invalid_request: 400,
  too_many_events: 400,
  unauthorized: 401,
  project_disabled: 403,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  quota_exceeded: 429,
  unavailable: 503,
};

/** Codes an SDK may retry, after Retry-After when present. */
export const RETRYABLE_INGEST_ERROR_CODES: ReadonlySet<IngestErrorCode> = new Set([
  "rate_limited",
  "quota_exceeded",
  "unavailable",
]);

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
      /** Events to enqueue, one per unique event_id, in request order. */
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

function failure(code: IngestErrorCode, message: string): IngestRequestResult {
  return { ok: false, status: INGEST_ERROR_STATUS[code], response: { error: { code, message } } };
}

function readEventId(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).event_id;
    if (typeof id === "string" && id.length <= 26) return id;
  }
  return undefined;
}

/**
 * Applies the request-level rules of the ingestion protocol to an already
 * parsed JSON body, then validates each event in ingest mode. Authentication,
 * rate limiting, content-type checks, and decompression happen before this in
 * the HTTP layer; this function covers steps 4 to 6 of "Processing" in the
 * protocol document. It never throws on bad input.
 */
export function validateIngestRequest(body: unknown, options: ValidateIngestRequestOptions = {}): IngestRequestResult {
  const now = options.now ?? new Date();
  const maxEvents = options.maxEvents ?? LIMITS.MAX_BATCH_EVENTS;
  const maxBodyBytes = options.maxBodyBytes ?? LIMITS.MAX_BATCH_BYTES;

  if (options.bodyBytes !== undefined && options.bodyBytes > maxBodyBytes) {
    return failure("payload_too_large", `request body is ${options.bodyBytes} bytes; the maximum is ${maxBodyBytes}`);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return failure("invalid_request", "request body must be a JSON object");
  }
  const events = (body as Record<string, unknown>).events;
  if (!Array.isArray(events)) {
    return failure("invalid_request", "events must be an array");
  }
  if (events.length === 0) {
    return failure("invalid_request", "events must contain at least one event");
  }
  if (events.length > maxEvents) {
    return failure("too_many_events", `events contains ${events.length} items; the maximum is ${maxEvents}`);
  }

  // Clock skew: evaluate the future-timestamp rule against the client's clock
  // when it told us what time it thinks it is.
  let referenceNow = now;
  let skewMs: number | undefined;
  const sentAt = (body as Record<string, unknown>).sent_at;
  if (typeof sentAt === "string" && TIMESTAMP_PATTERN.test(sentAt)) {
    const sentMs = Date.parse(sentAt);
    if (!Number.isNaN(sentMs)) {
      skewMs = sentMs - now.getTime();
      referenceNow = new Date(sentMs);
    }
  }

  const accepted: AcceptedEvent[] = [];
  const duplicates: number[] = [];
  const rejected: IngestRejection[] = [];
  const warnings: IngestWarning[] = [];
  const seen = new Set<string>();

  events.forEach((raw, index) => {
    const result = validateEvent(raw, { mode: "ingest", now: referenceNow });
    for (const w of result.warnings) warnings.push({ index, ...w });
    if (!result.ok) {
      const rejection: IngestRejection = { index, errors: result.errors };
      const id = readEventId(raw);
      if (id !== undefined) rejection.event_id = id;
      rejected.push(rejection);
      return;
    }
    if (seen.has(result.event.event_id)) {
      duplicates.push(index);
      return;
    }
    seen.add(result.event.event_id);
    accepted.push({ index, event: result.event });
  });

  const response: IngestResponse = {
    accepted: accepted.map((a) => a.event.event_id),
    rejected,
  };
  if (warnings.length > 0) response.warnings = warnings;

  const out: IngestRequestResult = { ok: true, accepted, duplicates, rejected, warnings, response };
  if (skewMs !== undefined) out.skewMs = skewMs;
  return out;
}
