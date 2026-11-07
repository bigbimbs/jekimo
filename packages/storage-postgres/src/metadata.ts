/**
 * PostgreSQL metadata repository: users, sessions, projects, roles,
 * memberships, ingestion keys, issues, daily counters, redaction rules, and
 * the audit log. Cross-project reads live in cross-project.ts.
 */

import {
  DEFAULT_PROJECT_ROLES,
  isProjectPermission,
  PROJECT_PERMISSIONS,
  type ProjectPermission,
} from "@jekimo/event-schema";
import { mintProjectAccess, type ProjectAccess } from "./access.js";
import { PostgresAccessRepository } from "./access-repository.js";
import {
  findIngestionKey,
  listProjectRetention,
  listProjectsForActor,
  PROJECT_COLUMNS,
  type ProjectRow,
  toProject,
} from "./cross-project.js";
import { withTransaction } from "./pool.js";
import { checkCounterIncrement, isUtcDay, normalizeRedactionRules } from "./project-settings.js";
import { firstRow } from "./rows.js";
import { insertAudit, requirePermission, toUser, USER_COLUMNS, type UserRow } from "./sql-shared.js";
import type {
  Actor,
  AuditEntry,
  DailyCounterIncrement,
  DailyCounters,
  FingerprintSummary,
  IngestionKeyLookup,
  IngestionKeyRecord,
  IssueSummary,
  MetadataRepository,
  ProjectRecord,
  ProjectRetention,
  RedactionRules,
  SessionRecord,
  UserRecord,
} from "./types.js";

export class PostgresMetadataRepository extends PostgresAccessRepository implements MetadataRepository {
  async countUsers(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM users");
    return Number(firstRow(rows, "count users").n);
  }

  createFirstAdmin(input: { email: string; passwordHash: string }): Promise<UserRecord | null> {
    return withTransaction(this.pool, async (client) => {
      // Two concurrent setup requests must not both create an admin.
      await client.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
      const existing = await client.query("SELECT 1 FROM users LIMIT 1");
      if (existing.rowCount !== 0) return null;
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users AS u (email, password_hash, instance_role) VALUES ($1, $2, 'admin')
         RETURNING ${USER_COLUMNS}`,
        [input.email, input.passwordHash],
      );
      const user = toUser(firstRow(rows, "insert first admin"));
      await insertAudit(client, {
        actorUserId: user.id,
        action: "user.created",
        targetType: "user",
        targetId: user.id,
        details: { instance_role: "admin", via: "setup" },
      });
      return user;
    });
  }

  async findUserForLogin(email: string): Promise<{ user: UserRecord; passwordHash: string } | null> {
    const { rows } = await this.pool.query<UserRow & { password_hash: string }>(
      `SELECT ${USER_COLUMNS}, u.password_hash FROM users u WHERE lower(u.email) = lower($1)`,
      [email],
    );
    const r = rows[0];
    return r ? { user: toUser(r), passwordHash: r.password_hash } : null;
  }

  async countFailedLogins(userId: string, since: Date): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
       WHERE action = 'auth.login_failed' AND target_type = 'user' AND target_id = $1 AND occurred_at >= $2`,
      [userId, since.toISOString()],
    );
    return Number(firstRow(rows, "count failed logins").n);
  }

  async createSession(input: {
    userId: string;
    tokenHash: Uint8Array;
    csrfToken: string;
    expiresAt: Date;
    sourceIp?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, source_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.userId,
        Buffer.from(input.tokenHash),
        input.csrfToken,
        input.expiresAt.toISOString(),
        input.sourceIp ?? null,
        input.userAgent?.slice(0, 256) ?? null,
      ],
    );
  }

  async findSession(tokenHash: Uint8Array, now: Date): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<
      UserRow & { session_id: string; csrf_token: string; s_created_at: Date; last_seen_at: Date; expires_at: Date }
    >(
      `SELECT ${USER_COLUMNS}, s.id AS session_id, s.csrf_token, s.created_at AS s_created_at, s.last_seen_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.status = 'active'`,
      [Buffer.from(tokenHash), now.toISOString()],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      sessionId: r.session_id,
      user: toUser(r),
      csrfToken: r.csrf_token,
      createdAt: r.s_created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
    };
  }

  async touchSession(sessionId: string, now: Date): Promise<void> {
    await this.pool.query("UPDATE sessions SET last_seen_at = $2 WHERE id = $1 AND revoked_at IS NULL", [
      sessionId,
      now.toISOString(),
    ]);
  }

  async revokeSession(sessionId: string, now: Date): Promise<void> {
    await this.pool.query("UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [
      sessionId,
      now.toISOString(),
    ]);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    await insertAudit(this.pool, entry);
  }

  createProject(
    actor: Actor,
    input: { id: string; name: string; retentionDays: number; sourceIp?: string },
  ): Promise<ProjectRecord> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<ProjectRow>(
        `INSERT INTO projects AS p (id, name, retention_days) VALUES ($1, $2, $3) RETURNING ${PROJECT_COLUMNS}`,
        [input.id, input.name, input.retentionDays],
      );
      let adminRoleId = "";
      for (const [name, permissions] of Object.entries(DEFAULT_PROJECT_ROLES)) {
        const role = await client.query<{ id: string }>(
          "INSERT INTO project_roles (project_id, name, permissions, built_in) VALUES ($1, $2, $3, true) RETURNING id",
          [input.id, name, [...permissions]],
        );
        if (name === "admin") adminRoleId = firstRow(role.rows, "insert built-in role").id;
      }
      await client.query("INSERT INTO project_members (project_id, user_id, role_id) VALUES ($1, $2, $3)", [
        input.id,
        actor.userId,
        adminRoleId,
      ]);
      await insertAudit(client, {
        actorUserId: actor.userId,
        action: "project.created",
        targetType: "project",
        targetId: input.id,
        projectId: input.id,
        ...(input.sourceIp !== undefined && { sourceIp: input.sourceIp }),
      });
      return toProject(firstRow(rows, "insert project"));
    });
  }

  listProjects(actor: Actor): Promise<ProjectRecord[]> {
    return listProjectsForActor(this.pool, actor);
  }

  async resolveProjectAccess(actor: Actor, projectId: string): Promise<ProjectAccess | null> {
    const { rows } = await this.pool.query<{ id: string; permissions: string[] | null }>(
      `SELECT p.id, r.permissions FROM projects p
       LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $2
       LEFT JOIN project_roles r ON r.id = m.role_id
       WHERE p.id = $1`,
      [projectId, actor.userId],
    );
    const r = rows[0];
    if (!r) return null;
    const isMember = r.permissions !== null;
    if (!isMember && actor.instanceRole !== "admin") return null;
    const permissions: ProjectPermission[] =
      actor.instanceRole === "admin" ? [...PROJECT_PERMISSIONS] : (r.permissions ?? []).filter(isProjectPermission);
    return mintProjectAccess({
      projectId: r.id,
      userId: actor.userId,
      permissions: new Set(permissions),
      viaInstanceAdmin: !isMember,
    });
  }

  async getProject(access: ProjectAccess): Promise<ProjectRecord> {
    requirePermission(access, "project.read");
    const { rows } = await this.pool.query<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`, [
      access.projectId,
    ]);
    if (!rows[0]) throw new Error("project no longer exists");
    return toProject(rows[0]);
  }

  createIngestionKey(
    access: ProjectAccess,
    input: { keyId: string; keyHash: Uint8Array; name: string; sourceIp?: string },
  ): Promise<IngestionKeyRecord> {
    requirePermission(access, "keys.manage");
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ key_id: string; project_id: string; name: string; created_at: Date }>(
        `INSERT INTO ingestion_keys (key_id, project_id, key_hash, name, created_by) VALUES ($1, $2, $3, $4, $5)
         RETURNING key_id, project_id, name, created_at`,
        [input.keyId, access.projectId, Buffer.from(input.keyHash), input.name, access.userId],
      );
      await insertAudit(client, {
        actorUserId: access.userId,
        action: "ingestion_key.created",
        targetType: "ingestion_key",
        targetId: input.keyId,
        projectId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        ...(input.sourceIp !== undefined && { sourceIp: input.sourceIp }),
      });
      const r = firstRow(rows, "insert ingestion key");
      return { keyId: r.key_id, projectId: r.project_id, name: r.name, createdAt: r.created_at };
    });
  }

  findIngestionKey(keyId: string): Promise<IngestionKeyLookup | null> {
    return findIngestionKey(this.pool, keyId);
  }

  async getProjectSettings(projectId: string): Promise<{ retentionDays: number; sampleRate: number } | null> {
    const { rows } = await this.pool.query<{ retention_days: number; sample_rate: number }>(
      "SELECT retention_days, sample_rate FROM projects WHERE id = $1",
      [projectId],
    );
    const r = rows[0];
    return r ? { retentionDays: r.retention_days, sampleRate: r.sample_rate } : null;
  }

  async upsertIssues(projectId: string, summaries: IssueSummary[]): Promise<void> {
    if (summaries.length === 0) return;
    await this.pool.query(
      `INSERT INTO issues AS i (project_id, fingerprint, title, kind, last_severity, event_count, first_seen, last_seen)
       SELECT $1, fingerprint, title, kind, last_severity, event_count, first_seen, last_seen
       FROM jsonb_to_recordset($2::jsonb) AS r(fingerprint text, title text, kind text, last_severity text,
         event_count bigint, first_seen timestamptz, last_seen timestamptz)
       ON CONFLICT (project_id, fingerprint) DO UPDATE SET
         event_count = GREATEST(i.event_count, EXCLUDED.event_count),
         first_seen = LEAST(i.first_seen, EXCLUDED.first_seen),
         last_severity = CASE WHEN EXCLUDED.last_seen >= i.last_seen THEN EXCLUDED.last_severity ELSE i.last_severity END,
         last_seen = GREATEST(i.last_seen, EXCLUDED.last_seen),
         updated_at = now()`,
      [
        projectId,
        JSON.stringify(
          summaries.map((s) => ({
            fingerprint: s.fingerprint,
            title: s.title.slice(0, 256),
            kind: s.kind,
            last_severity: s.lastSeverity,
            event_count: s.eventCount,
            first_seen: s.firstSeen.toISOString(),
            last_seen: s.lastSeen.toISOString(),
          })),
        ),
      ],
    );
  }

  replaceIssueCounts(projectId: string, summaries: FingerprintSummary[], asOf: Date): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        "DELETE FROM issues WHERE project_id = $1 AND NOT (fingerprint = ANY($2::text[])) AND updated_at < $3",
        [projectId, summaries.map((s) => s.fingerprint), asOf.toISOString()],
      );
      if (summaries.length === 0) return;
      await client.query(
        `UPDATE issues i SET event_count = r.event_count, first_seen = r.first_seen, last_seen = r.last_seen, updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS r(fingerprint text, event_count bigint, first_seen timestamptz, last_seen timestamptz)
         WHERE i.project_id = $1 AND i.fingerprint = r.fingerprint AND i.updated_at < $3`,
        [
          projectId,
          JSON.stringify(
            summaries.map((s) => ({
              fingerprint: s.fingerprint,
              event_count: s.eventCount,
              first_seen: s.firstSeen.toISOString(),
              last_seen: s.lastSeen.toISOString(),
            })),
          ),
          asOf.toISOString(),
        ],
      );
    });
  }

  listProjectRetention(): Promise<ProjectRetention[]> {
    return listProjectRetention(this.pool);
  }

  async incrementDailyCounters(projectId: string, input: DailyCounterIncrement): Promise<boolean> {
    const counts = checkCounterIncrement(input);
    // One statement: the idempotency key and the counts commit together, and
    // a concurrent repeat of the key waits on the first and then adds nothing.
    const { rowCount } = await this.pool.query(
      `WITH k AS (
         INSERT INTO project_counter_increments (project_id, increment_key)
         SELECT $1, $2::text WHERE $2::text IS NOT NULL
         ON CONFLICT DO NOTHING RETURNING 1
       )
       INSERT INTO project_daily_counters AS c (project_id, day, accepted, rejected, dropped, sampled)
       SELECT $1, $3::date, $4, $5, $6, $7 WHERE $2::text IS NULL OR EXISTS (SELECT 1 FROM k)
       ON CONFLICT (project_id, day) DO UPDATE SET
         accepted = c.accepted + EXCLUDED.accepted,
         rejected = c.rejected + EXCLUDED.rejected,
         dropped = c.dropped + EXCLUDED.dropped,
         sampled = c.sampled + EXCLUDED.sampled,
         updated_at = now()`,
      [
        projectId,
        input.idempotencyKey ?? null,
        input.day,
        counts.accepted,
        counts.rejected,
        counts.dropped,
        counts.sampled,
      ],
    );
    return rowCount === 1;
  }

  async listDailyCounters(access: ProjectAccess, range: { from: string; to: string }): Promise<DailyCounters[]> {
    requirePermission(access, "project.read");
    if (!isUtcDay(range.from) || !isUtcDay(range.to))
      throw new RangeError("counter range must be UTC days, YYYY-MM-DD");
    const { rows } = await this.pool.query<{
      day: string;
      accepted: string;
      rejected: string;
      dropped: string;
      sampled: string;
    }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, accepted, rejected, dropped, sampled
       FROM project_daily_counters WHERE project_id = $1 AND day BETWEEN $2::date AND $3::date ORDER BY day`,
      [access.projectId, range.from, range.to],
    );
    return rows.map((r) => ({
      day: r.day,
      accepted: Number(r.accepted),
      rejected: Number(r.rejected),
      dropped: Number(r.dropped),
      sampled: Number(r.sampled),
    }));
  }

  async pruneDailyCounters(beforeDay: string, keysBefore: Date): Promise<{ counters: number; keys: number }> {
    if (!isUtcDay(beforeDay)) throw new RangeError("beforeDay must be a UTC day, YYYY-MM-DD");
    const counters = await this.pool.query("DELETE FROM project_daily_counters WHERE day < $1::date", [beforeDay]);
    const keys = await this.pool.query("DELETE FROM project_counter_increments WHERE created_at < $1", [
      keysBefore.toISOString(),
    ]);
    return { counters: counters.rowCount ?? 0, keys: keys.rowCount ?? 0 };
  }

  async getRedactionRules(projectId: string): Promise<RedactionRules | null> {
    const { rows } = await this.pool.query<{ redaction_rules: RedactionRules }>(
      "SELECT redaction_rules FROM projects WHERE id = $1",
      [projectId],
    );
    const r = rows[0];
    return r ? { keys: r.redaction_rules.keys, patterns: r.redaction_rules.patterns } : null;
  }

  async setRedactionRules(access: ProjectAccess, rules: RedactionRules, sourceIp?: string): Promise<RedactionRules> {
    requirePermission(access, "settings.manage");
    const normalized = normalizeRedactionRules(rules);
    return await withTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query(
        "UPDATE projects SET redaction_rules = $2::jsonb, updated_at = now() WHERE id = $1",
        [access.projectId, JSON.stringify(normalized)],
      );
      if (rowCount !== 1) throw new Error("project no longer exists");
      // Counts only: the rules themselves can describe what a project hides.
      await insertAudit(client, {
        actorUserId: access.userId,
        action: "project.redaction_rules_updated",
        targetType: "project",
        targetId: access.projectId,
        projectId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        details: { keys: normalized.keys.length, patterns: normalized.patterns.length },
        ...(sourceIp !== undefined && { sourceIp }),
      });
      return normalized;
    });
  }
}
