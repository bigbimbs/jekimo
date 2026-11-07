/**
 * Integration test helper: a throwaway schema in the database named by
 * DATABASE_URL, migrated from scratch, dropped afterwards. Tests that use it
 * are skipped when DATABASE_URL is not set.
 */

import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "./migrate.js";
import type { Pool } from "./pool.js";

export const hasDatabase = Boolean(process.env.DATABASE_URL);

export interface TestDatabase {
  pool: Pool;
  schema: string;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const schema = `jekimo_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
  pool.on("error", () => {});
  await migrate(pool);
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
