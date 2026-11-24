export interface DatabaseQuery {
  system: "postgresql" | "mysql" | "sqlite" | "mongodb" | "redis" | "other";
  operation: "select" | "insert" | "update" | "delete" | "other";
  name: string;
  duration_ms: number;
  status: "ok" | "error";
}
export type DatabaseQueryOptions = Pick<DatabaseQuery, "name" | "system" | "operation">;
