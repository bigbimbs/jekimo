import type { Pool } from "./pool.js";

export interface TestDatabase {
  pool: Pool;
  schema: string;
  close(): Promise<void>;
}
