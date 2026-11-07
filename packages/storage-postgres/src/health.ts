/**
 * Readiness probes for the API's `GET /readyz`. Each is one cheap query that
 * fails when PostgreSQL is unreachable or the schema has not been migrated.
 */

import type { Pool } from "./types/pool.js";

export async function checkDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1 FROM users LIMIT 1");
}

/** Reads no job payloads. */
export async function checkQueue(pool: Pool): Promise<void> {
  await pool.query("SELECT 1 FROM queue_jobs LIMIT 1");
}
