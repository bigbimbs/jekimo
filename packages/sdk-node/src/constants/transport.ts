// Retry schedule from docs/ingestion-protocol.md, "SDK requirements".

export const GZIP_THRESHOLD_BYTES = 8 * 1024;
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 60_000;
/** Bounds one request so a stalled connection cannot hold the sender forever. */
export const REQUEST_TIMEOUT_MS = 10_000;
