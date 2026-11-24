import type { DatabaseQuery } from "@jekimo/event-schema";
import type { DatabaseMetrics, DatabaseSummary } from "../types/database.js";
export function summarizeDatabaseRows(rows: DatabaseQuery[], slowMs: number): DatabaseSummary {
  const metrics = (rs: DatabaseQuery[]): DatabaseMetrics => {
    const times = rs.map((r) => r.duration_ms).sort((a, b) => a - b);
    const totalMs = times.reduce((a, b) => a + b, 0);
    const rank = (times.length - 1) * 0.95;
    const low = times[Math.floor(rank)] ?? 0,
      high = times[Math.ceil(rank)] ?? 0;
    return {
      count: rs.length,
      errors: rs.filter((r) => r.status === "error").length,
      slow: rs.filter((r) => r.duration_ms >= slowMs).length,
      totalMs,
      averageMs: rs.length ? totalMs / rs.length : 0,
      p95Ms: low + (high - low) * (rank - Math.floor(rank)),
    };
  };
  const groups = new Map<string, DatabaseQuery[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.name, r.system, r.operation]);
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }
  return {
    totals: metrics(rows),
    groups: [...groups.values()]
      .map((rs) => ({
        name: rs[0]?.name ?? "",
        system: rs[0]?.system ?? "",
        operation: rs[0]?.operation ?? "",
        ...metrics(rs),
      }))
      .sort(
        (a, b) =>
          b.totalMs - a.totalMs ||
          a.name.localeCompare(b.name) ||
          a.system.localeCompare(b.system) ||
          a.operation.localeCompare(b.operation),
      )
      .slice(0, 100),
  };
}
