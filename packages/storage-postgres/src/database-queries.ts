import type { DatabaseGroup, DatabaseMetrics, DatabaseSummary, DatabaseWindow } from "./types/database.js";
import type { Pool } from "./types/pool.js";

export async function summarizeDatabase(
  pool: Pool,
  projectId: string,
  query: DatabaseWindow,
): Promise<DatabaseSummary> {
  const { rows } = await pool.query<DatabaseGroup & { all: number }>(
    `
    SELECT database->>'name' AS name, database->>'system' AS system, database->>'operation' AS operation,
      grouping(database->>'name',database->>'system',database->>'operation') AS "all",
      count(*)::float8 AS count,
      count(*) FILTER (WHERE database->>'status'='error')::float8 AS errors,
      count(*) FILTER (WHERE (database->>'duration_ms')::float8 >= $4)::float8 AS slow,
      coalesce(avg((database->>'duration_ms')::float8),0) AS "averageMs",
      coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY (database->>'duration_ms')::float8),0) AS "p95Ms",
      coalesce(sum((database->>'duration_ms')::float8),0) AS "totalMs"
    FROM events WHERE project_id=$1 AND received_at >= $2 AND received_at < $3 AND database IS NOT NULL
      AND ($5::text IS NULL OR environment=$5)
    GROUP BY GROUPING SETS ((database->>'name',database->>'system',database->>'operation'),())
    ORDER BY "all" DESC, "totalMs" DESC, name, system, operation LIMIT 101`,
    [projectId, query.from, query.to, query.slowMs, query.environment ?? null],
  );
  const metrics = (r: DatabaseMetrics): DatabaseMetrics => ({
    count: r.count,
    errors: r.errors,
    slow: r.slow,
    averageMs: r.averageMs,
    p95Ms: r.p95Ms,
    totalMs: r.totalMs,
  });
  const total = rows.find((r) => r.all === 7);
  return {
    totals: total ? metrics(total) : { count: 0, errors: 0, slow: 0, averageMs: 0, p95Ms: 0, totalMs: 0 },
    groups: rows
      .filter((r) => r.all === 0)
      .map((r) => ({ name: r.name, system: r.system, operation: r.operation, ...metrics(r) })),
  };
}
