/**
 * Readiness probes for the API's `GET /readyz`. Each is one cheap query that
 * fails when PostgreSQL is unreachable or the schema has not been migrated.
 */

import type { Pool } from "./pool.js";

/** Metadata tables are reachable. */
export async function checkDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1 FROM users LIMIT 1");
}

/** The durable queue table is reachable. Reads no job payloads. */
export async function checkQueue(pool: Pool): Promise<void> {
  await pool.query("SELECT 1 FROM queue_jobs LIMIT 1");
}
