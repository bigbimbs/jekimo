/**
 * Plain-SQL migration runner. Files in migrations/ are named
 * `NNNN_description.sql` and applied in numeric order, each in its own
 * transaction, and recorded in schema_migrations. Applied files are never
 * edited; a change is a new file.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { daysFrom, PostgresEventStore } from "./event-store.js";
import type { Pool } from "./pool.js";

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** Arbitrary constant so concurrent runners wait for each other. */
const MIGRATION_LOCK_KEY = 0x6a656b69; // "jeki"
/** Event partitions are created this many days ahead of today. */
const PARTITION_DAYS_AHEAD = 7;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Defaults to JEKIMO_MIGRATIONS_DIR, else this package's migrations/ directory. */
export function defaultMigrationsDir(): string {
  return process.env.JEKIMO_MIGRATIONS_DIR ?? fileURLToPath(new URL("../migrations", import.meta.url));
}

export async function loadMigrations(dir: string = defaultMigrationsDir()): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const name of files) {
    const m = MIGRATION_FILE.exec(name);
    if (!m) throw new Error(`migration file name ${name} does not match NNNN_description.sql`);
    const version = Number(m[1]);
    if (migrations.some((x) => x.version === version)) throw new Error(`duplicate migration version ${version}`);
    migrations.push({ version, name, sql: await readFile(join(dir, name), "utf8") });
  }
  return migrations;
}

/** Applies pending migrations and returns the names applied in this run. */
export async function migrate(pool: Pool, migrations?: Migration[]): Promise<string[]> {
  const all = migrations ?? (await loadMigrations());
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: number }>("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((r) => r.version));
    const applied: string[] = [];
    for (const migration of all) {
      if (done.has(migration.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
          migration.version,
          migration.name,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${migration.name} failed: ${(err as Error).message}`);
      }
      applied.push(migration.name);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/**
 * What `npm run migrate` and JEKIMO_MIGRATE_ON_START do: applies pending
 * migrations, then creates event partitions for yesterday through a week
 * ahead. Safe to run concurrently and repeatedly.
 */
export async function runMigrations(pool: Pool, migrations?: Migration[]): Promise<string[]> {
  const applied = await migrate(pool, migrations);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await new PostgresEventStore(pool).prepareDays(daysFrom(yesterday, PARTITION_DAYS_AHEAD + 2));
  return applied;
}

/** Reads JEKIMO_MIGRATE_ON_START: whether the API and worker migrate before serving. */
export function migrateOnStart(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.JEKIMO_MIGRATE_ON_START;
  if (raw === undefined || raw === "" || raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  throw new Error("JEKIMO_MIGRATE_ON_START must be true or false");
}
