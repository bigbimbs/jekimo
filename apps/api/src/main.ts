/**
 * API entry point. Reads configuration from the environment, connects to
 * PostgreSQL, prints the one-time setup token when the instance has no
 * users yet, and serves until SIGTERM or SIGINT.
 */

import { randomBytes } from "node:crypto";
import {
  checkDatabase,
  checkQueue,
  createPool,
  type DiskConfig,
  DiskMonitor,
  diskConfigFromEnv,
  diskProbeFor,
  INGEST_QUEUE,
  type IngestJob,
  migrateOnStart,
  PostgresEventStore,
  PostgresIngestLimitStore,
  PostgresMetadataRepository,
  PostgresQueue,
  queuePolicyFromEnv,
  runMigrations,
} from "@jekimo/storage-postgres";
import { buildApp, loggerOptions } from "./app.js";
import { type ApiConfig, loadApiConfig } from "./config.js";

async function main(): Promise<void> {
  let config: ApiConfig;
  let disk: DiskConfig;
  try {
    config = loadApiConfig();
    disk = diskConfigFromEnv();
  } catch (err) {
    throw new Error(`invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pool = createPool({ applicationName: "jekimo-api" });
  if (migrateOnStart()) {
    const applied = await runMigrations(pool);
    console.log(applied.length === 0 ? "schema is up to date" : `applied migrations: ${applied.join(", ")}`);
  }
  const metadata = new PostgresMetadataRepository(pool);

  let setupToken: string | null = null;
  if ((await metadata.countUsers()) === 0) {
    setupToken = randomBytes(24).toString("base64url");
    // Printed on purpose and only here: the operator needs it to create the
    // first admin. It is not written through the structured logger.
    process.stdout.write(
      [
        "",
        "  Jekimo has no users yet. Create the first instance admin and project with this one-time setup token:",
        "",
        `    ${setupToken}`,
        "",
        '  POST /api/v1/setup with {"setup_token", "email", "password", "project_name"}. See docs/local-development.md.',
        "  The token is valid until setup completes or the API restarts.",
        "",
        "",
      ].join("\n"),
    );
  }

  const app = await buildApp({
    metadata,
    events: new PostgresEventStore(pool),
    queue: new PostgresQueue<IngestJob>(pool, INGEST_QUEUE, queuePolicyFromEnv()),
    limits: new PostgresIngestLimitStore(pool),
    disk: new DiskMonitor({
      probe: diskProbeFor(disk, pool),
      thresholds: disk.thresholds,
      // Ingest refuses while the probe fails; say why in the logs.
      onError: (err) => app.log.error({ err }, "disk probe failed; refusing ingestion"),
    }),
    config,
    setupToken,
    readiness: { database: () => checkDatabase(pool), queue: () => checkQueue(pool) },
    logger: loggerOptions(config.logLevel),
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await pool.end();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "api failed to start");
  process.exit(1);
});
