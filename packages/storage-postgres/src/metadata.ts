/**
 * PostgreSQL metadata repository: users, sessions, projects, roles,
 * memberships, ingestion keys, issues, and the audit log.
 */

import {
  DEFAULT_PROJECT_ROLES,
  isProjectPermission,
  PROJECT_PERMISSIONS,
  type ProjectPermission,
} from "@jekimo/event-schema";
import { assertProjectAccess, mintProjectAccess, type ProjectAccess } from "./access.js";
import { type Pool, type PoolClient, withTransaction } from "./pool.js";
import { firstRow } from "./rows.js";
import type {
  Actor,
  AuditEntry,
  FingerprintSummary,
  IngestionKeyLookup,
  IngestionKeyRecord,
  IssueSummary,
  MetadataRepository,
  ProjectRecord,
  ProjectRetention,
  SessionRecord,
  UserRecord,
} from "./types.js";

interface UserRow {
  id: string;
  email: string;
  instance_role: UserRecord["instanceRole"];
  status: UserRecord["status"];
  created_at: Date;
}

interface ProjectRow {
  id: string;
  name: string;
  retention_days: number;
  sample_rate: number;
  disabled: boolean;
  created_at: Date;
}

const USER_COLUMNS = "u.id, u.email, u.instance_role, u.status, u.created_at";
const PROJECT_COLUMNS = "p.id, p.name, p.retention_days, p.sample_rate, p.disabled, p.created_at";

function toUser(r: UserRow): UserRecord {
  return { id: r.id, email: r.email, instanceRole: r.instance_role, status: r.status, createdAt: r.created_at };
}

function toProject(r: ProjectRow): ProjectRecord {
  return {
    id: r.id,
    name: r.name,
    retentionDays: r.retention_days,
    sampleRate: r.sample_rate,
    disabled: r.disabled,
    createdAt: r.created_at,
  };
}

async function insertAudit(db: Pool | PoolClient, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, project_id, source_ip, via_instance_admin, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      entry.actorUserId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.projectId ?? null,
      entry.sourceIp ?? null,
      entry.viaInstanceAdmin ?? false,
      JSON.stringify(entry.details ?? {}),
    ],
  );
}

function requirePermission(access: ProjectAccess, permission: ProjectPermission): void {
  assertProjectAccess(access);
  if (!access.permissions.has(permission)) throw new Error(`missing permission ${permission}`);
}

export class PostgresMetadataRepository implements MetadataRepository {
  constructor(private readonly pool: Pool) {}

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

  async listProjects(actor: Actor): Promise<ProjectRecord[]> {
    // Instance-admin listing and membership listing are the only
    // cross-project reads (docs/access-model.md, "Authorization enforcement").
    const { rows } =
      actor.instanceRole === "admin"
        ? await this.pool.query<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM projects p ORDER BY p.created_at, p.id`)
        : await this.pool.query<ProjectRow>(
            `SELECT ${PROJECT_COLUMNS} FROM projects p JOIN project_members m ON m.project_id = p.id
             WHERE m.user_id = $1 ORDER BY p.created_at, p.id`,
            [actor.userId],
          );
    return rows.map(toProject);
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

  async findIngestionKey(keyId: string): Promise<IngestionKeyLookup | null> {
    const { rows } = await this.pool.query<{
      key_id: string;
      project_id: string;
      key_hash: Buffer;
      revoked_at: Date | null;
      expires_at: Date | null;
      disabled: boolean;
    }>(
      `SELECT k.key_id, k.project_id, k.key_hash, k.revoked_at, k.expires_at, p.disabled
       FROM ingestion_keys k JOIN projects p ON p.id = k.project_id WHERE k.key_id = $1`,
      [keyId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      keyId: r.key_id,
      projectId: r.project_id,
      keyHash: new Uint8Array(r.key_hash),
      revokedAt: r.revoked_at,
      expiresAt: r.expires_at,
      projectDisabled: r.disabled,
    };
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

  async listProjectRetention(): Promise<ProjectRetention[]> {
    const { rows } = await this.pool.query<{ id: string; retention_days: number }>(
      "SELECT id, retention_days FROM projects ORDER BY id",
    );
    return rows.map((r) => ({ projectId: r.id, retentionDays: r.retention_days }));
  }
}
