/**
 * `npm run migrate`: applies pending migrations, then creates event
 * partitions for yesterday through the next week. Reads JEKIMO_DATABASE_URL.
 */

import { runMigrations } from "./migrate.js";
import { createPool } from "./pool.js";

async function main(): Promise<void> {
  const pool = createPool({ applicationName: "jekimo-migrate", max: 2 });
  try {
    const applied = await runMigrations(pool);
    for (const name of applied) console.log(`applied ${name}`);
    if (applied.length === 0) console.log("schema is up to date");
    console.log("event partitions ready through 7 days ahead");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "migration failed");
  process.exitCode = 1;
});
