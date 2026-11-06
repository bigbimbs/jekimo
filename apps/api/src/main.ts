/**
 * API entry point. Reads configuration from the environment, connects to
 * PostgreSQL, prints the one-time setup token when the instance has no
 * users yet, and serves until SIGTERM or SIGINT.
 */

import { randomBytes } from "node:crypto";
import { createPool, INGEST_QUEUE, PostgresEventStore, PostgresMetadataRepository, PostgresQueue, type IngestJob } from "@jekimo/storage-postgres";
import { buildApp, loggerOptions } from "./app.js";
import { loadApiConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const pool = createPool({ applicationName: "jekimo-api" });
  const metadata = new PostgresMetadataRepository(pool);

  let setupToken: string | null = null;
  if ((await metadata.countUsers()) === 0) {
    setupToken = randomBytes(24).toString("base64url");
    // Printed on purpose and only here: the operator needs it to create the
    // first admin. It is not written through the structured logger.
    process.stdout.write(
      [
        "",
        "  Jekimo has no users yet. Create the first instance admin with this one-time setup token:",
        "",
        `    ${setupToken}`,
        "",
        "  POST /api/v1/setup with {\"setup_token\", \"email\", \"password\"}. See docs/local-development.md.",
        "  The token is valid until setup completes or the API restarts.",
        "",
      ].join("\n") + "\n",
    );
  }

  const app = await buildApp({
    metadata,
    events: new PostgresEventStore(pool),
    queue: new PostgresQueue<IngestJob>(pool, INGEST_QUEUE),
    config,
    setupToken,
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
