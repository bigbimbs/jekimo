import { LIMITS } from "@jekimo/event-schema";

export const DEFAULTS = {
  maxQueueSize: 1000,
  flushIntervalMs: 2000,
  maxBatchEvents: LIMITS.MAX_BATCH_EVENTS,
  maxBatchBytes: 512 * 1024,
  shutdownTimeoutMs: 2000,
} as const;

/** Bytes of `{"sent_at":"<24 chars>","events":[]}` plus slack. */
export const BODY_OVERHEAD_BYTES = 64;

export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
