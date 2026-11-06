/**
 * Worker entry point. Reads configuration from the environment and runs the
 * queue loop and expiry pass until SIGTERM or SIGINT.
 */

import pino from "pino";
import {
  createPool,
  INGEST_QUEUE,
  PostgresEventStore,
  PostgresMetadataRepository,
  PostgresQueue,
  queuePolicyFromEnv,
  type IngestJob,
} from "@jekimo/storage-postgres";
import { loadWorkerConfig } from "./config.js";
import { Worker } from "./worker.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const log = pino({ level: config.logLevel, base: { service: "jekimo-worker" } });
  const pool = createPool({ applicationName: "jekimo-worker" });
  const worker = new Worker({
    queue: new PostgresQueue<IngestJob>(pool, INGEST_QUEUE, queuePolicyFromEnv()),
    metadata: new PostgresMetadataRepository(pool),
    events: new PostgresEventStore(pool),
    log,
    batchSize: config.batchSize,
    pollMs: config.pollMs,
    expiryIntervalMs: config.expiryIntervalMinutes * 60_000,
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    await worker.stop();
    await pool.end();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  log.info({ batch_size: config.batchSize, expiry_interval_minutes: config.expiryIntervalMinutes }, "worker started");
  worker.start();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "worker failed to start");
  process.exit(1);
});
