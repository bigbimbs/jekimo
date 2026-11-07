/**
 * `npm run migrate`: applies pending migrations, then creates event
 * partitions for yesterday through the next week. Reads DATABASE_URL.
 */

import { daysFrom, PostgresEventStore } from "./event-store.js";
import { migrate } from "./migrate.js";
import { createPool } from "./pool.js";

const PARTITION_DAYS_AHEAD = 7;

async function main(): Promise<void> {
  const pool = createPool({ applicationName: "jekimo-migrate", max: 2 });
  try {
    const applied = await migrate(pool);
    for (const name of applied) console.log(`applied ${name}`);
    if (applied.length === 0) console.log("schema is up to date");
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await new PostgresEventStore(pool).prepareDays(daysFrom(yesterday, PARTITION_DAYS_AHEAD + 2));
    console.log(`event partitions ready through ${PARTITION_DAYS_AHEAD} days ahead`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "migration failed");
  process.exitCode = 1;
});
