import type { JekimoClient } from "./client.js";
import type { DatabaseQuery } from "./database.js";
export interface PostgresTarget {
  query: (...args: never[]) => unknown;
}
export interface PostgresInstrumentationOptions {
  client: JekimoClient;
  /** Static label for all calls through this target. Defaults to postgres.query. */
  name?: string;
  operation?: DatabaseQuery["operation"];
}
export interface PostgresInstrumentation {
  readonly installed: boolean;
  restore(): void;
}
