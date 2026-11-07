import type { IngestErrorCode } from "../types/ingest.js";

export const INGEST_PATH = "/api/v1/ingest" as const;

/** `jk_<key_id:12 Crockford base32>_<secret:32 [a-z0-9]>` */
export const INGESTION_KEY_PATTERN = /^jk_([0-9A-HJKMNP-TV-Z]{12})_([a-z0-9]{32})$/;

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
