import type pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  /** Defaults to databaseUrl(): JEKIMO_DATABASE_URL, else the deprecated DATABASE_URL. */
  connectionString?: string;
  /** Defaults to JEKIMO_DATABASE_POOL_MAX, else 10. */
  max?: number;
  applicationName?: string;
}
