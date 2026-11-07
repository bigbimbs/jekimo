// Counts are derived from the event store (docs/architecture.md, "Storage
// engines", rule 3); every status change is audit-logged
// (docs/access-model.md, "Audit log").

import type { AuditAction } from "./constants/audit.js";
import { type IssueStatus, MAX_ISSUE_ENVIRONMENTS } from "./constants/issues.js";
import { withTransaction } from "./pool.js";
import type { ProjectAccess } from "./types/access.js";
import type { AuditEntry } from "./types/audit.js";
import type { IssuePage, IssueQuery, IssueRecord, IssueSummary } from "./types/issues.js";
import type { Pool, PoolClient } from "./types/pool.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isIssueId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function issueStatusAction(status: IssueStatus): AuditAction {
  return status === "unresolved" ? "issue.reopened" : `issue.${status}`;
}

export function mergeEnvironments(a: readonly string[], b: readonly string[] = []): string[] {
  return [...new Set([...a, ...b])].sort().slice(0, MAX_ISSUE_ENVIRONMENTS);
}

interface IssueCursor {
  lastSeen: Date;
  id: string;
}

export function encodeIssueCursor(issue: Pick<IssueRecord, "lastSeen" | "id">): string {
  return Buffer.from(JSON.stringify([issue.lastSeen.getTime(), issue.id])).toString("base64url");
}

/** Throws RangeError for anything encodeIssueCursor did not produce. */
export function decodeIssueCursor(cursor: string): IssueCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [ms, id] = parsed as [unknown, unknown];
      if (typeof ms === "number" && Number.isSafeInteger(ms) && typeof id === "string" && isIssueId(id)) {
        return { lastSeen: new Date(ms), id: id.toLowerCase() };
      }
    }
  } catch {}
  throw new RangeError("invalid issue cursor");
}

interface IssueRow {
  id: string;
  project_id: string;
  fingerprint: string;
  title: string;
  kind: IssueRecord["kind"];
  last_severity: IssueRecord["lastSeverity"];
  status: IssueStatus;
  event_count: string;
  first_seen: Date;
  last_seen: Date;
  last_event_id: string | null;
  environments: string[];
  status_changed_at: Date | null;
}

const ISSUE_COLUMNS = `i.id, i.project_id, i.fingerprint, i.title, i.kind, i.last_severity, i.status, i.event_count,
  i.first_seen, i.last_seen, i.last_event_id, i.environments, i.status_changed_at`;

function toIssue(r: IssueRow): IssueRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    fingerprint: r.fingerprint,
    title: r.title,
    kind: r.kind,
    lastSeverity: r.last_severity,
    status: r.status,
    eventCount: Number(r.event_count),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    environments: r.environments,
    ...(r.last_event_id !== null && { lastEventId: r.last_event_id }),
    ...(r.status_changed_at !== null && { statusChangedAt: r.status_changed_at }),
  };
}

type InsertAudit = (db: PoolClient, entry: AuditEntry) => Promise<void>;

/**
 * Counts and last_seen only move forward, so a retry converges. Also reopens
 * resolved issues seen after their resolution and audit-logs the regression.
 */
export function upsertIssues(
  pool: Pool,
  insertAudit: InsertAudit,
  projectId: string,
  summaries: IssueSummary[],
): Promise<void> {
  if (summaries.length === 0) return Promise.resolve();
  const records = JSON.stringify(
    summaries.map((s) => ({
      fingerprint: s.fingerprint,
      title: s.title.slice(0, 256),
      kind: s.kind,
      last_severity: s.lastSeverity,
      event_count: s.eventCount,
      first_seen: s.firstSeen.toISOString(),
      last_seen: s.lastSeen.toISOString(),
      last_event_id: s.lastEventId ?? null,
      environments: mergeEnvironments(s.environments ?? []),
    })),
  );
  const recordset = `jsonb_to_recordset($2::jsonb) AS r(fingerprint text, title text, kind text, last_severity text,
    event_count bigint, first_seen timestamptz, last_seen timestamptz, last_event_id text, environments text[])`;
  return withTransaction(pool, async (client) => {
    const reopened = await client.query<{ id: string }>(
      `UPDATE issues i SET status = 'unresolved', status_changed_at = now(), status_changed_by = NULL
       FROM ${recordset}
       WHERE i.project_id = $1 AND i.fingerprint = r.fingerprint AND i.status = 'resolved'
         AND r.last_seen > COALESCE(i.status_changed_at, '-infinity'::timestamptz)
       RETURNING i.id`,
      [projectId, records],
    );
    for (const { id } of reopened.rows) {
      await insertAudit(client, {
        actorUserId: null,
        action: "issue.regressed",
        targetType: "issue",
        targetId: id,
        projectId,
        details: { from: "resolved", to: "unresolved" },
      });
    }
    await client.query(
      `INSERT INTO issues AS i (project_id, fingerprint, title, kind, last_severity, event_count, first_seen, last_seen,
         last_event_id, environments)
       SELECT $1, fingerprint, title, kind, last_severity, event_count, first_seen, last_seen, last_event_id, environments
       FROM ${recordset}
       ON CONFLICT (project_id, fingerprint) DO UPDATE SET
         event_count = GREATEST(i.event_count, EXCLUDED.event_count),
         first_seen = LEAST(i.first_seen, EXCLUDED.first_seen),
         last_severity = CASE WHEN EXCLUDED.last_seen >= i.last_seen THEN EXCLUDED.last_severity ELSE i.last_severity END,
         last_event_id = CASE WHEN EXCLUDED.last_seen >= i.last_seen AND EXCLUDED.last_event_id IS NOT NULL
           THEN EXCLUDED.last_event_id ELSE i.last_event_id END,
         environments = (SELECT COALESCE(array_agg(e ORDER BY e), '{}') FROM (
           SELECT DISTINCT e FROM unnest(i.environments || EXCLUDED.environments) AS e ORDER BY e LIMIT ${MAX_ISSUE_ENVIRONMENTS}
         ) AS merged),
         last_seen = GREATEST(i.last_seen, EXCLUDED.last_seen),
         updated_at = now()`,
      [projectId, records],
    );
  });
}

export async function listIssues(pool: Pool, access: ProjectAccess, query: IssueQuery): Promise<IssuePage> {
  const params: unknown[] = [access.projectId];
  const where = ["i.project_id = $1"];
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value);
    where.push(sql(params.length));
  };
  if (query.statuses) add((n) => `i.status = ANY($${n}::text[])`, query.statuses);
  if (query.kinds) add((n) => `i.kind = ANY($${n}::text[])`, query.kinds);
  if (query.severities) add((n) => `i.last_severity = ANY($${n}::text[])`, query.severities);
  if (query.environment !== undefined) add((n) => `$${n}::text = ANY(i.environments)`, query.environment);
  if (query.from) add((n) => `i.last_seen >= $${n}`, query.from.toISOString());
  if (query.to) add((n) => `i.first_seen < $${n}`, query.to.toISOString());
  if (query.cursor !== undefined) {
    const c = decodeIssueCursor(query.cursor);
    params.push(c.lastSeen.toISOString(), c.id);
    where.push(`(i.last_seen, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(query.limit + 1);
  const { rows } = await pool.query<IssueRow>(
    `SELECT ${ISSUE_COLUMNS} FROM issues i WHERE ${where.join(" AND ")}
     ORDER BY i.last_seen DESC, i.id DESC LIMIT $${params.length}`,
    params,
  );
  const issues = rows.slice(0, query.limit).map(toIssue);
  const last = issues[issues.length - 1];
  return rows.length > query.limit && last ? { issues, nextCursor: encodeIssueCursor(last) } : { issues };
}

export async function getIssue(db: Pool | PoolClient, projectId: string, issueId: string): Promise<IssueRecord | null> {
  if (!isIssueId(issueId)) return null;
  const { rows } = await db.query<IssueRow>(
    `SELECT ${ISSUE_COLUMNS} FROM issues i WHERE i.project_id = $1 AND i.id = $2`,
    [projectId, issueId],
  );
  return rows[0] ? toIssue(rows[0]) : null;
}

export function setIssueStatus(
  pool: Pool,
  insertAudit: InsertAudit,
  access: ProjectAccess,
  issueId: string,
  status: IssueStatus,
  sourceIp?: string,
): Promise<IssueRecord | null> {
  if (!isIssueId(issueId)) return Promise.resolve(null);
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: IssueStatus }>(
      "SELECT status FROM issues WHERE project_id = $1 AND id = $2 FOR UPDATE",
      [access.projectId, issueId],
    );
    const current = rows[0];
    if (!current) return null;
    if (current.status !== status) {
      await client.query(
        `UPDATE issues SET status = $3, status_changed_at = now(), status_changed_by = $4
         WHERE project_id = $1 AND id = $2`,
        [access.projectId, issueId, status, access.userId],
      );
      await insertAudit(client, {
        actorUserId: access.userId,
        action: issueStatusAction(status),
        targetType: "issue",
        targetId: issueId,
        projectId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        details: { from: current.status, to: status },
        ...(sourceIp !== undefined && { sourceIp }),
      });
    }
    return getIssue(client, access.projectId, issueId);
  });
}
