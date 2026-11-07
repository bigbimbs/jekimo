/**
 * `npm run recompute-issues -w @jekimo/worker [-- <project id>]`, or
 * `node dist/recompute.mjs [<project id>]` in the worker image: rebuilds
 * issue counts from the event store. Reads JEKIMO_DATABASE_URL. Safe to run
 * while the worker is running.
 */

import { createPool, PostgresEventStore, PostgresMetadataRepository } from "@jekimo/storage-postgres";
import { recomputeIssues } from "./recompute.js";

async function main(): Promise<void> {
  const projectId = process.argv[2];
  const pool = createPool({ applicationName: "jekimo-recompute", max: 2 });
  try {
    const result = await recomputeIssues(
      { metadata: new PostgresMetadataRepository(pool), events: new PostgresEventStore(pool) },
      projectId === undefined ? {} : { projectId },
    );
    console.log(`recomputed ${result.fingerprints} issues in ${result.projects} projects`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "recompute failed");
  process.exitCode = 1;
});
