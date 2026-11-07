import type { QueuePolicy } from "../types/queue.js";

/** Queue that carries accepted events from the ingest endpoint to the worker. */
export const INGEST_QUEUE = "ingest";

export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  visibilityTimeoutMs: 60_000,
  maxAttempts: 5,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  maxDepth: 10_000,
};
