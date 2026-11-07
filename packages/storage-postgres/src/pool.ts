import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  /** Defaults to databaseUrl(): JEKIMO_DATABASE_URL, else the deprecated DATABASE_URL. */
  connectionString?: string;
  /** Defaults to JEKIMO_DATABASE_POOL_MAX, else 10. */
  max?: number;
  applicationName?: string;
}

let warnedDeprecatedUrl = false;

/**
 * Reads JEKIMO_DATABASE_URL, falling back to the deprecated DATABASE_URL, or
 * throws a message that does not echo either value.
 */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JEKIMO_DATABASE_URL) return env.JEKIMO_DATABASE_URL;
  if (env.DATABASE_URL) {
    if (!warnedDeprecatedUrl) {
      warnedDeprecatedUrl = true;
      process.emitWarning("DATABASE_URL is deprecated; set JEKIMO_DATABASE_URL instead", "DeprecationWarning");
    }
    return env.DATABASE_URL;
  }
  throw new Error("JEKIMO_DATABASE_URL is not set");
}

export function createPool(options: PoolOptions = {}): Pool {
  const max = options.max ?? Number(process.env.JEKIMO_DATABASE_POOL_MAX ?? 10);
  const pool = new pg.Pool({
    connectionString: options.connectionString ?? databaseUrl(),
    max: Number.isInteger(max) && max > 0 ? max : 10,
    application_name: options.applicationName ?? "jekimo",
  });
  // An idle client losing its connection must not crash the process; the
  // next query reconnects.
  pool.on("error", () => {});
  return pool;
}

/** Runs `fn` in a transaction on one client. */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
