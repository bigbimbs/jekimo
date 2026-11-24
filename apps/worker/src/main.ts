import {
  createPool,
  DiskMonitor,
  diskConfigFromEnv,
  diskProbeFor,
  INGEST_QUEUE,
  type IngestJob,
  migrateOnStart,
  notificationKey,
  PostgresCronRepository,
  PostgresEventStore,
  PostgresMetadataRepository,
  PostgresNotificationRepository,
  PostgresQueue,
  queuePolicyFromEnv,
  runMigrations,
} from "@jekimo/storage-postgres";
import pino from "pino";
import { loadWorkerConfig } from "./config.js";
import { CronWorker } from "./cron.js";
import { NotificationWorker } from "./notifications.js";
import { Worker } from "./worker.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const disk = diskConfigFromEnv();
  const notificationsKey = process.env.JEKIMO_NOTIFICATIONS_ENCRYPTION_KEY || null;
  if (notificationsKey) notificationKey(notificationsKey);
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
    notifications: new PostgresNotificationRepository(pool),
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
    auditLogDays: config.auditLogDays,
  });

  const cron = new CronWorker(new PostgresCronRepository(pool), () => log.error("cron monitoring failed"));
  const notifications = notificationsKey
    ? new NotificationWorker(
        new PostgresNotificationRepository(pool),
        notificationsKey,
        process.env.JEKIMO_PUBLIC_URL?.replace(/\/+$/, "") || null,
        () => log.error("notification processing failed"),
      )
    : null;

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    await Promise.all([worker.stop(), notifications?.stop(), cron.stop()]);
    await pool.end();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  log.info({ batch_size: config.batchSize, expiry_interval_minutes: config.expiryIntervalMinutes }, "worker started");
  worker.start();
  notifications?.start();
  cron.start();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "worker failed to start");
  process.exit(1);
});
