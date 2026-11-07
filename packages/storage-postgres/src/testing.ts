/**
 * Integration test helper: a throwaway schema in the database named by
 * JEKIMO_DATABASE_URL (or the deprecated DATABASE_URL), migrated from
 * scratch, dropped afterwards. Tests that use it are skipped when neither is
 * set.
 */

import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "./migrate.js";
import type { Pool } from "./pool.js";

const testDatabaseUrl = process.env.JEKIMO_DATABASE_URL || process.env.DATABASE_URL;

export const hasDatabase = Boolean(testDatabaseUrl);

export interface TestDatabase {
  pool: Pool;
  schema: string;
  close(): Promise<void>;
}

/** A fresh schema. Pass `migrate: false` to get it empty, without migrations. */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const connectionString = testDatabaseUrl;
  if (!connectionString) throw new Error("JEKIMO_DATABASE_URL is not set");
  const schema = `jekimo_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
  pool.on("error", () => {});
  if (options.migrate !== false) await migrate(pool);
  return {
    pool,
    schema,
    async close() {
      await pool.end();
      const c = new pg.Client({ connectionString });
      await c.connect();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    },
  };
}
