/**
 * Worker entry point. Reads configuration from the environment and runs the
 * queue loop and expiry pass until SIGTERM or SIGINT.
 */

import {
  createPool,
  DiskMonitor,
  diskConfigFromEnv,
  diskProbeFor,
  INGEST_QUEUE,
  type IngestJob,
  migrateOnStart,
  PostgresEventStore,
  PostgresMetadataRepository,
  PostgresQueue,
  queuePolicyFromEnv,
  runMigrations,
} from "@jekimo/storage-postgres";
import pino from "pino";
import { loadWorkerConfig } from "./config.js";
import { Worker } from "./worker.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const disk = diskConfigFromEnv();
  const log = pino({ level: config.logLevel, base: { service: "jekimo-worker" } });
  const pool = createPool({ applicationName: "jekimo-worker" });
  if (migrateOnStart()) {
    const applied = await runMigrations(pool);
    log.info({ applied }, applied.length === 0 ? "schema is up to date" : "migrations applied");
  }
  const worker = new Worker({
    queue: new PostgresQueue<IngestJob>(pool, INGEST_QUEUE, queuePolicyFromEnv()),
    metadata: new PostgresMetadataRepository(pool),
    events: new PostgresEventStore(pool),
    log,
    batchSize: config.batchSize,
    pollMs: config.pollMs,
    expiryIntervalMs: config.expiryIntervalMinutes * 60_000,
    retentionDefaultDays: config.retentionDefaultDays,
    retentionMaxDays: config.retentionMaxDays,
    disk: new DiskMonitor({
      probe: diskProbeFor(disk, pool),
      thresholds: disk.thresholds,
      onError: (err) => log.error({ err }, "disk probe failed"),
    }),
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
