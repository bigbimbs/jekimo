// Variables documented in docs/configuration.md.

import { RETENTION } from "@jekimo/event-schema";
import type { WorkerConfig } from "./types/index.js";

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const retentionMaxDays = int(
    env,
    "JEKIMO_RETENTION_MAX_DAYS",
    RETENTION.MAX_DAYS,
    RETENTION.MIN_DAYS,
    RETENTION.MAX_DAYS,
  );
  return {
    logLevel: env.JEKIMO_LOG_LEVEL || "info",
    batchSize: int(env, "JEKIMO_WORKER_BATCH_SIZE", 10, 1, 100),
    pollMs: int(env, "JEKIMO_WORKER_POLL_MS", 1000, 50, 60_000),
    expiryIntervalMinutes: int(env, "JEKIMO_EXPIRY_INTERVAL_MINUTES", 15, 1, 15),
    retentionDefaultDays: int(
      env,
      "JEKIMO_RETENTION_DEFAULT_DAYS",
      RETENTION.DEFAULT_DAYS,
      RETENTION.MIN_DAYS,
      retentionMaxDays,
    ),
    retentionMaxDays,
    auditLogDays: int(env, "JEKIMO_AUDIT_LOG_DAYS", RETENTION.AUDIT_LOG_DAYS, 1, RETENTION.MAX_DAYS),
  };
}
