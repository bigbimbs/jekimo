import type { DatabaseQuery } from "@jekimo/event-schema";
import type { StoredEvent } from "./api";
export interface DatabaseMetrics {
  count: number;
  errors: number;
  slow: number;
  averageMs: number;
  p95Ms: number;
  totalMs: number;
}
export interface DatabaseSummary {
  from: string;
  to: string;
  slow_ms: number;
  totals: DatabaseMetrics;
  groups: (DatabaseMetrics & { name: string; system: string; operation: DatabaseQuery["operation"] })[];
  recent: StoredEvent[];
}
export interface DatabaseFilter {
  from: string;
  to: string;
  slow_ms: number;
  environment?: string;
}
