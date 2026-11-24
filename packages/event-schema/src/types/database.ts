import type { DATABASE_OPERATIONS, DATABASE_STATUSES, DATABASE_SYSTEMS } from "../constants/database.js";
export interface DatabaseQuery {
  system: (typeof DATABASE_SYSTEMS)[number];
  operation: (typeof DATABASE_OPERATIONS)[number];
  /** Static operation label, never SQL or parameters. */
  name: string;
  duration_ms: number;
  status: (typeof DATABASE_STATUSES)[number];
}
