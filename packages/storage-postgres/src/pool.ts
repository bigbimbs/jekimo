import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  /** Defaults to the DATABASE_URL environment variable. */
  connectionString?: string;
  /** Defaults to JEKIMO_DATABASE_POOL_MAX, else 10. */
  max?: number;
  applicationName?: string;
}

/** Reads DATABASE_URL, or throws a message that does not echo its value. */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
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
