export interface DatabaseWindow {
  from: Date;
  to: Date;
  slowMs: number;
  environment?: string;
}
export interface DatabaseMetrics {
  count: number;
  errors: number;
  slow: number;
  averageMs: number;
  p95Ms: number;
  totalMs: number;
}
export interface DatabaseGroup extends DatabaseMetrics {
  name: string;
  system: string;
  operation: string;
}
export interface DatabaseSummary {
  totals: DatabaseMetrics;
  groups: DatabaseGroup[];
}
