/**
 * Worker configuration from environment variables. Documented in
 * docs/configuration.md.
 */

import { RETENTION } from "@jekimo/event-schema";

export interface WorkerConfig {
  logLevel: string;
  /** Jobs claimed per dequeue. Each job is one ingest request of up to 100 events. */
  batchSize: number;
  /** Wait between polls when the queue is empty. */
  pollMs: number;
  /** docs/retention.md requires an expiry pass at least every 15 minutes. */
  expiryIntervalMinutes: number;
  auditLogDays: number;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    logLevel: env.JEKIMO_LOG_LEVEL || "info",
    batchSize: int(env, "JEKIMO_WORKER_BATCH_SIZE", 10, 1, 100),
    pollMs: int(env, "JEKIMO_WORKER_POLL_MS", 1000, 50, 60_000),
    expiryIntervalMinutes: int(env, "JEKIMO_EXPIRY_INTERVAL_MINUTES", 15, 1, 15),
    auditLogDays: int(env, "JEKIMO_AUDIT_LOG_DAYS", RETENTION.AUDIT_LOG_DAYS, 1, RETENTION.MAX_DAYS),
  };
}
