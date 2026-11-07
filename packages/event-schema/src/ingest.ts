// Normative text: docs/ingestion-protocol.md.

import { TIMESTAMP_PATTERN } from "./constants/envelope.js";
import { INGEST_ERROR_STATUS, INGESTION_KEY_PATTERN } from "./constants/ingest.js";
import { LIMITS } from "./constants/limits.js";
import type {
  AcceptedEvent,
  IngestErrorCode,
  IngestRejection,
  IngestRequestResult,
  IngestResponse,
  IngestWarning,
  ParsedIngestionKey,
  ValidateIngestRequestOptions,
} from "./types/ingest.js";
import { validateEvent } from "./validate.js";

/** Parses an ingestion key. Returns null for anything that is not well-formed. */
export function parseIngestionKey(value: unknown): ParsedIngestionKey | null {
  if (typeof value !== "string") return null;
  const [, keyId, secret] = INGESTION_KEY_PATTERN.exec(value) ?? [];
  if (keyId === undefined || secret === undefined) return null;
  return { keyId, secret };
}

/** Extracts the bearer token from an Authorization header value, or null. */
export function bearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

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

  // The future-timestamp rule is evaluated against sent_at when it is usable
  // (docs/ingestion-protocol.md, "Clock skew").
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
