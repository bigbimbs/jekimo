// Rules that depend on more than one row (the last instance admin, the last
// project admin, docs/access-model.md) are checked in a transaction that locks
// the rows the decision depends on, so two concurrent requests cannot both pass.

import { canAssignRole, isProjectPermission, type ProjectPermission } from "@jekimo/event-schema";
import type { ProjectAccess } from "./access.js";
import { PROJECT_COLUMNS, type ProjectRow, toProject } from "./cross-project.js";
import { type Pool, type PoolClient, withTransaction } from "./pool.js";
import { firstRow } from "./rows.js";
import { insertAudit, isUuid, requirePermission, toUser, USER_COLUMNS } from "./sql-shared.js";
import type {
  AccessRepository,
  AuditQuery,
  AuditRecord,
  IngestionKeySummary,
  InvitationRecord,
  MemberRecord,
  PasswordResetRecord,
  ProjectSettingsChange,
  Result,
  RoleRecord,
  SessionSummary,
  UserRow,
} from "./types/index.js";
import type { Actor, InstanceRole, ProjectRecord, UserRecord } from "./types.js";

function requireInstanceAdmin(actor: Actor | null): void {
  if (actor !== null && actor.instanceRole !== "admin") throw new Error("instance admin required");
}

function ip(sourceIp: string | undefined): { sourceIp?: string } {
  return sourceIp === undefined ? {} : { sourceIp };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "23505";
}

interface KeyRow {
  key_id: string;
  name: string;
  created_at: Date;
  created_by: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const KEY_COLUMNS = "key_id, name, created_at, created_by, expires_at, revoked_at";

function toKey(r: KeyRow): IngestionKeySummary {
  return {
    keyId: r.key_id,
    name: r.name,
    createdAt: r.created_at,
    createdBy: r.created_by,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  };
}

interface RoleRow {
  id: string;
  name: string;
  permissions: string[];
  built_in: boolean;
}

function rolePermissions(r: RoleRow): Set<ProjectPermission> {
  return new Set(r.permissions.filter(isProjectPermission));
}

function isAdminRole(r: Pick<RoleRow, "name" | "built_in">): boolean {
  return r.built_in && r.name === "admin";
}

interface MemberRow extends UserRow {
  role: string;
  built_in: boolean;
  member_created_at: Date;
}

const MEMBER_SELECT = `SELECT ${USER_COLUMNS}, r.name AS role, r.built_in, m.created_at AS member_created_at
  FROM project_members m JOIN users u ON u.id = m.user_id JOIN project_roles r ON r.id = m.role_id`;

function toMember(r: MemberRow): MemberRecord {
  return {
    userId: r.id,
    email: r.email,
    status: r.status,
    role: r.role,
    isAdmin: isAdminRole({ name: r.role, built_in: r.built_in }),
    createdAt: r.member_created_at,
  };
}

interface TokenRow {
  id: string;
  email: string | null;
  instance_role: InstanceRole | null;
  user_id: string | null;
  created_by: string | null;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

const TOKEN_COLUMNS = "id, email, instance_role, user_id, created_by, created_at, expires_at, used_at, revoked_at";

function toInvitation(r: TokenRow): InvitationRecord {
  return {
    id: r.id,
    email: r.email ?? "",
    instanceRole: r.instance_role ?? "member",
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

function isPending(r: TokenRow, now: Date): boolean {
  return r.used_at === null && r.revoked_at === null && r.expires_at > now;
}

export class PostgresAccessRepository implements AccessRepository {
  constructor(protected readonly pool: Pool) {}

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users u WHERE lower(u.email) = lower($1)`,
      [email],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async listUsers(actor: Actor): Promise<UserRecord[]> {
    requireInstanceAdmin(actor);
    const { rows } = await this.pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u ORDER BY u.created_at, u.id`);
    return rows.map(toUser);
  }

  updateUser(
    actor: Actor,
    userId: string,
    change: { instanceRole?: InstanceRole; status?: UserRecord["status"] },
    meta: { now: Date; sourceIp?: string },
  ): Promise<Result<{ user: UserRecord }, "not_found" | "last_admin">> {
    requireInstanceAdmin(actor);
    if (!isUuid(userId)) return Promise.resolve({ ok: false, reason: "not_found" });
    return withTransaction(this.pool, async (client) => {
      // Lock every active admin, so concurrent demotions take turns.
      const admins = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE instance_role = 'admin' AND status = 'active' FOR UPDATE",
      );
      const { rows } = await client.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1 FOR UPDATE`, [
        userId,
      ]);
      const before = rows[0];
      if (!before) return { ok: false, reason: "not_found" };
      const role = change.instanceRole ?? before.instance_role;
      const status = change.status ?? before.status;
      const wasActiveAdmin = before.instance_role === "admin" && before.status === "active";
      const isActiveAdmin = role === "admin" && status === "active";
      if (wasActiveAdmin && !isActiveAdmin && admins.rows.length <= 1) return { ok: false, reason: "last_admin" };
      const updated = await client.query<UserRow>(
        `UPDATE users u SET instance_role = $2, status = $3, updated_at = now() WHERE u.id = $1 RETURNING ${USER_COLUMNS}`,
        [userId, role, status],
      );
      const audit = { actorUserId: actor.userId, targetType: "user", targetId: userId, ...ip(meta.sourceIp) };
      if (role !== before.instance_role) {
        await insertAudit(client, {
          ...audit,
          action: "user.role_changed",
          details: { before: before.instance_role, after: role },
        });
      }
      if (status !== before.status) {
        let revoked = 0;
        if (status === "deactivated") revoked = await revokeAllSessions(client, userId, meta.now);
        await insertAudit(client, {
          ...audit,
          action: status === "deactivated" ? "user.deactivated" : "user.reactivated",
          ...(status === "deactivated" && { details: { sessions_revoked: revoked } }),
        });
      }
      return { ok: true, user: toUser(firstRow(updated.rows, "update user")) };
    });
  }

  async listSessions(userId: string, now: Date): Promise<SessionSummary[]> {
    const { rows } = await this.pool.query<{
      id: string;
      created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
      source_ip: string | null;
      user_agent: string | null;
    }>(
      `SELECT id, created_at, last_seen_at, expires_at, source_ip, user_agent FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY last_seen_at DESC, id`,
      [userId, now.toISOString()],
    );
    return rows.map((r) => ({
      sessionId: r.id,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      sourceIp: r.source_ip,
      userAgent: r.user_agent,
    }));
  }

  async revokeOwnSession(userId: string, sessionId: string, meta: { now: Date; sourceIp?: string }): Promise<boolean> {
    if (!isUuid(sessionId)) return false;
    return withTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE sessions SET revoked_at = $3
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3`,
        [sessionId, userId, meta.now.toISOString()],
      );
      if (rowCount !== 1) return false;
      await insertAudit(client, {
        actorUserId: userId,
        action: "session.revoked",
        targetType: "user",
        targetId: userId,
        details: { session_id: sessionId },
        ...ip(meta.sourceIp),
      });
      return true;
    });
  }

  async revokeUserSessions(actor: Actor, userId: string, meta: { now: Date; sourceIp?: string }): Promise<number> {
    requireInstanceAdmin(actor);
    if (!isUuid(userId)) return 0;
    return withTransaction(this.pool, async (client) => {
      const revoked = await revokeAllSessions(client, userId, meta.now);
      await insertAudit(client, {
        actorUserId: actor.userId,
        action: "session.revoked",
        targetType: "user",
        targetId: userId,
        details: { sessions_revoked: revoked },
        ...ip(meta.sourceIp),
      });
      return revoked;
    });
  }

  async changePassword(
    userId: string,
    passwordHash: string,
    meta: { now: Date; keepSessionId: string; sourceIp?: string },
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [
        userId,
        passwordHash,
      ]);
      const { rowCount } = await client.query(
        "UPDATE sessions SET revoked_at = $3 WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL",
        [userId, meta.keepSessionId, meta.now.toISOString()],
      );
      await revokePendingResets(client, userId, meta.now);
      await insertAudit(client, {
        actorUserId: userId,
        action: "user.password_changed",
        targetType: "user",
        targetId: userId,
        details: { sessions_revoked: rowCount ?? 0 },
        ...ip(meta.sourceIp),
      });
    });
  }

  createInvitation(
    actor: Actor,
    input: { email: string; instanceRole: InstanceRole; tokenHash: Uint8Array; expiresAt: Date; sourceIp?: string },
  ): Promise<Result<{ invitation: InvitationRecord }, "email_taken">> {
    requireInstanceAdmin(actor);
    return withTransaction(this.pool, async (client) => {
      const taken = await client.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [input.email]);
      if (taken.rowCount !== 0) return { ok: false, reason: "email_taken" };
      await client.query(
        `UPDATE account_tokens SET revoked_at = now()
         WHERE purpose = 'invitation' AND lower(email) = lower($1) AND used_at IS NULL AND revoked_at IS NULL`,
        [input.email],
      );
      const { rows } = await client.query<TokenRow>(
        `INSERT INTO account_tokens (purpose, token_hash, email, instance_role, created_by, expires_at)
         VALUES ('invitation', $1, $2, $3, $4, $5) RETURNING ${TOKEN_COLUMNS}`,
        [Buffer.from(input.tokenHash), input.email, input.instanceRole, actor.userId, input.expiresAt.toISOString()],
      );
      const invitation = toInvitation(firstRow(rows, "insert invitation"));
      await insertAudit(client, {
        actorUserId: actor.userId,
        action: "user.invited",
        targetType: "invitation",
        targetId: invitation.id,
        details: { email: invitation.email, instance_role: invitation.instanceRole },
        ...ip(input.sourceIp),
      });
      return { ok: true, invitation };
    });
  }

  async listInvitations(actor: Actor, now: Date): Promise<InvitationRecord[]> {
    requireInstanceAdmin(actor);
    const { rows } = await this.pool.query<TokenRow>(
      `SELECT ${TOKEN_COLUMNS} FROM account_tokens
       WHERE purpose = 'invitation' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $1
       ORDER BY created_at, id`,
      [now.toISOString()],
    );
    return rows.map(toInvitation);
  }

  async revokeInvitation(actor: Actor, invitationId: string, meta: { now: Date; sourceIp?: string }): Promise<boolean> {
    requireInstanceAdmin(actor);
    if (!isUuid(invitationId)) return false;
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ email: string }>(
        `UPDATE account_tokens SET revoked_at = $2
         WHERE id = $1 AND purpose = 'invitation' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2
         RETURNING email`,
        [invitationId, meta.now.toISOString()],
      );
      const r = rows[0];
      if (!r) return false;
      await insertAudit(client, {
        actorUserId: actor.userId,
        action: "user.invitation_revoked",
        targetType: "invitation",
        targetId: invitationId,
        details: { email: r.email },
        ...ip(meta.sourceIp),
      });
      return true;
    });
  }

  async acceptInvitation(
    tokenHash: Uint8Array,
    passwordHash: string,
    meta: { now: Date; sourceIp?: string },
  ): Promise<Result<{ user: UserRecord }, "invalid_token" | "email_taken">> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const { rows } = await client.query<TokenRow>(
          `SELECT ${TOKEN_COLUMNS} FROM account_tokens WHERE token_hash = $1 AND purpose = 'invitation' FOR UPDATE`,
          [Buffer.from(tokenHash)],
        );
        const token = rows[0];
        if (!token || !isPending(token, meta.now) || token.email === null || token.instance_role === null) {
          return { ok: false, reason: "invalid_token" } as const;
        }
        const created = await client.query<UserRow>(
          `INSERT INTO users AS u (email, password_hash, instance_role) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
          [token.email, passwordHash, token.instance_role],
        );
        const user = toUser(firstRow(created.rows, "insert invited user"));
        await client.query("UPDATE account_tokens SET used_at = $2 WHERE id = $1", [token.id, meta.now.toISOString()]);
        await insertAudit(client, {
          actorUserId: user.id,
          action: "user.activated",
          targetType: "user",
          targetId: user.id,
          details: { invitation_id: token.id, instance_role: user.instanceRole, invited_by: token.created_by },
          ...ip(meta.sourceIp),
        });
        return { ok: true, user } as const;
      });
    } catch (err) {
      // users_email_key: someone took the email after the invitation was made.
      if (isUniqueViolation(err)) return { ok: false, reason: "email_taken" };
      throw err;
    }
  }

  createPasswordReset(
    actor: Actor | null,
    input: { userId: string; tokenHash: Uint8Array; expiresAt: Date; sourceIp?: string },
  ): Promise<Result<{ reset: PasswordResetRecord }, "not_found">> {
    requireInstanceAdmin(actor);
    if (!isUuid(input.userId)) return Promise.resolve({ ok: false, reason: "not_found" });
    return withTransaction(this.pool, async (client) => {
      const user = await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      if (user.rowCount !== 1) return { ok: false, reason: "not_found" };
      await client.query(
        `UPDATE account_tokens SET revoked_at = now()
         WHERE purpose = 'password_reset' AND user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
        [input.userId],
      );
      const { rows } = await client.query<TokenRow>(
        `INSERT INTO account_tokens (purpose, token_hash, user_id, created_by, expires_at)
         VALUES ('password_reset', $1, $2, $3, $4) RETURNING ${TOKEN_COLUMNS}`,
        [Buffer.from(input.tokenHash), input.userId, actor?.userId ?? null, input.expiresAt.toISOString()],
      );
      const r = firstRow(rows, "insert password reset");
      await insertAudit(client, {
        actorUserId: actor?.userId ?? null,
        action: "user.password_reset_link_created",
        targetType: "user",
        targetId: input.userId,
        details: { reset_id: r.id, via: actor === null ? "cli" : "api" },
        ...ip(input.sourceIp),
      });
      return {
        ok: true,
        reset: { id: r.id, userId: input.userId, createdAt: r.created_at, expiresAt: r.expires_at },
      };
    });
  }

  resetPassword(
    tokenHash: Uint8Array,
    passwordHash: string,
    meta: { now: Date; sourceIp?: string },
  ): Promise<Result<{ user: UserRecord }, "invalid_token">> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<TokenRow>(
        `SELECT ${TOKEN_COLUMNS} FROM account_tokens WHERE token_hash = $1 AND purpose = 'password_reset' FOR UPDATE`,
        [Buffer.from(tokenHash)],
      );
      const token = rows[0];
      if (!token || !isPending(token, meta.now) || token.user_id === null)
        return { ok: false, reason: "invalid_token" };
      const updated = await client.query<UserRow>(
        `UPDATE users u SET password_hash = $2, updated_at = now() WHERE u.id = $1 RETURNING ${USER_COLUMNS}`,
        [token.user_id, passwordHash],
      );
      const user = toUser(firstRow(updated.rows, "reset password"));
      await client.query("UPDATE account_tokens SET used_at = $2 WHERE id = $1", [token.id, meta.now.toISOString()]);
      const revoked = await revokeAllSessions(client, user.id, meta.now);
      await insertAudit(client, {
        actorUserId: user.id,
        action: "user.password_reset",
        targetType: "user",
        targetId: user.id,
        details: { reset_id: token.id, sessions_revoked: revoked },
        ...ip(meta.sourceIp),
      });
      return { ok: true, user };
    });
  }

  async listAudit(actor: Actor, query: AuditQuery): Promise<AuditRecord[]> {
    requireInstanceAdmin(actor);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (query.actorUserId !== undefined) {
      if (!isUuid(query.actorUserId)) return [];
      add("a.actor_user_id = ?", query.actorUserId);
    }
    if (query.action !== undefined) add("a.action = ?", query.action);
    if (query.from !== undefined) add("a.occurred_at >= ?", query.from.toISOString());
    if (query.to !== undefined) add("a.occurred_at < ?", query.to.toISOString());
    if (query.beforeId !== undefined) add("a.id < ?", query.beforeId);
    params.push(query.limit);
    const { rows } = await this.pool.query<{
      id: string;
      occurred_at: Date;
      actor_user_id: string | null;
      actor_email: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      project_id: string | null;
      source_ip: string | null;
      via_instance_admin: boolean;
      details: Record<string, unknown>;
    }>(
      `SELECT a.id::text AS id, a.occurred_at, a.actor_user_id, u.email AS actor_email, a.action, a.target_type,
         a.target_id, a.project_id, a.source_ip, a.via_instance_admin, a.details
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY a.id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      actorUserId: r.actor_user_id,
      actorEmail: r.actor_email,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      projectId: r.project_id,
      sourceIp: r.source_ip,
      viaInstanceAdmin: r.via_instance_admin,
      details: r.details,
    }));
  }

  async pruneAudit(before: Date): Promise<number> {
    const { rowCount } = await this.pool.query("DELETE FROM audit_log WHERE occurred_at < $1", [before.toISOString()]);
    return rowCount ?? 0;
  }

  updateProject(access: ProjectAccess, change: ProjectSettingsChange, sourceIp?: string): Promise<ProjectRecord> {
    requirePermission(access, "settings.manage");
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1 FOR UPDATE`,
        [access.projectId],
      );
      if (!rows[0]) throw new Error("project no longer exists");
      const before = toProject(rows[0]);
      const after = { ...before, ...change };
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      if (after.name !== before.name) changes.name = { before: before.name, after: after.name };
      if (after.retentionDays !== before.retentionDays)
        changes.retention_days = { before: before.retentionDays, after: after.retentionDays };
      if (after.sampleRate !== before.sampleRate)
        changes.sample_rate = { before: before.sampleRate, after: after.sampleRate };
      if (Object.keys(changes).length === 0) return before;
      const updated = await client.query<ProjectRow>(
        `UPDATE projects p SET name = $2, retention_days = $3, sample_rate = $4, updated_at = now()
         WHERE p.id = $1 RETURNING ${PROJECT_COLUMNS}`,
        [access.projectId, after.name, after.retentionDays, after.sampleRate],
      );
      await insertAudit(client, {
        actorUserId: access.userId,
        action: "project.settings_updated",
        targetType: "project",
        targetId: access.projectId,
        projectId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        details: { changes },
        ...ip(sourceIp),
      });
      return toProject(firstRow(updated.rows, "update project"));
    });
  }

  async listRoles(access: ProjectAccess): Promise<RoleRecord[]> {
    requirePermission(access, "project.read");
    const { rows } = await this.pool.query<RoleRow & { description: string | null; members: string }>(
      `SELECT r.id, r.name, r.description, r.permissions, r.built_in, count(m.user_id) AS members
       FROM project_roles r LEFT JOIN project_members m ON m.role_id = r.id
       WHERE r.project_id = $1 GROUP BY r.id
       ORDER BY r.built_in DESC, CASE r.name WHEN 'admin' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, lower(r.name)`,
      [access.projectId],
    );
    return rows.map((r) => ({
      name: r.name,
      description: r.description,
      permissions: [...rolePermissions(r)],
      builtIn: r.built_in,
      memberCount: Number(r.members),
    }));
  }

  async listMembers(access: ProjectAccess): Promise<MemberRecord[]> {
    requirePermission(access, "project.read");
    const { rows } = await this.pool.query<MemberRow>(
      `${MEMBER_SELECT} WHERE m.project_id = $1 ORDER BY m.created_at, u.email`,
      [access.projectId],
    );
    return rows.map(toMember);
  }

  addMember(
    access: ProjectAccess,
    input: { userId: string; role: string; sourceIp?: string },
  ): Promise<Result<{ member: MemberRecord }, "user_not_found" | "already_member" | "unknown_role" | "escalation">> {
    requirePermission(access, "members.manage");
    return withTransaction(this.pool, async (client) => {
      await lockProject(client, access.projectId);
      const role = await findRole(client, access.projectId, input.role);
      if (!role) return { ok: false, reason: "unknown_role" };
      if (!canAssignRole(access.permissions, { permissions: rolePermissions(role) }))
        return { ok: false, reason: "escalation" };
      if (!isUuid(input.userId)) return { ok: false, reason: "user_not_found" };
      const user = await client.query("SELECT 1 FROM users WHERE id = $1", [input.userId]);
      if (user.rowCount !== 1) return { ok: false, reason: "user_not_found" };
      const inserted = await client.query(
        "INSERT INTO project_members (project_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [access.projectId, input.userId, role.id],
      );
      if (inserted.rowCount !== 1) return { ok: false, reason: "already_member" };
      await insertAudit(client, {
        actorUserId: access.userId,
        action: "member.added",
        targetType: "user",
        targetId: input.userId,
        projectId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        details: { role: role.name },
        ...ip(input.sourceIp),
      });
      return { ok: true, member: await getMember(client, access.projectId, input.userId) };
    });
  }

  changeMemberRole(
    access: ProjectAccess,
    input: { userId: string; role: string; force?: boolean; sourceIp?: string },
  ): Promise<Result<{ member: MemberRecord }, "not_member" | "unknown_role" | "escalation" | "last_admin">> {
    requirePermission(access, "members.manage");
    return withTransaction(this.pool, async (client) => {
      await lockProject(client, access.projectId);
      const current = await currentRole(client, access.projectId, input.userId);
      if (!current) return { ok: false, reason: "not_member" };
      const role = await findRole(client, access.projectId, input.role);
      if (!role) return { ok: false, reason: "unknown_role" };
      if (role.id === current.id) return { ok: true, member: await getMember(client, access.projectId, input.userId) };
      if (
        !canAssignRole(access.permissions, { permissions: rolePermissions(current) }) ||
        !canAssignRole(access.permissions, { permissions: rolePermissions(role) })
      )
        return { ok: false, reason: "escalation" };
      const forced = isAdminRole(current) && !isAdminRole(role) && (await isLastAdmin(client, access.projectId));
      if (forced && input.force !== true) return { ok: false, reason: "last_admin" };
      await client.query("UPDATE project_members SET role_id = $3 WHERE project_id = $1 AND user_id = $2", [
        access.projectId,
        input.userId,
        role.id,
      ]);
      await insertAudit(client, {
        actorUserId: access.userId,
        action: "member.role_changed",
        targetType: "user",
        targetId: input.userId,
        projectId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        details: { before: current.name, after: role.name, ...(forced && { last_admin_removed: true }) },
        ...ip(input.sourceIp),
      });
      return { ok: true, member: await getMember(client, access.projectId, input.userId) };
    });
  }

  removeMember(
    access: ProjectAccess,
    input: { userId: string; force?: boolean; sourceIp?: string },
  ): Promise<Result<{ member: MemberRecord }, "not_member" | "escalation" | "last_admin">> {
    requirePermission(access, "members.manage");
    return withTransaction(this.pool, async (client) => {
      await lockProject(client, access.projectId);
      const current = await currentRole(client, access.projectId, input.userId);
      if (!current) return { ok: false, reason: "not_member" };
      if (!canAssignRole(access.permissions, { permissions: rolePermissions(current) }))
        return { ok: false, reason: "escalation" };
      const forced = isAdminRole(current) && (await isLastAdmin(client, access.projectId));
      if (forced && input.force !== true) return { ok: false, reason: "last_admin" };
      const member = await getMember(client, access.projectId, input.userId);
      await client.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [
        access.projectId,
        input.userId,
      ]);
      await insertAudit(client, {
        actorUserId: access.userId,
        action: "member.removed",
        targetType: "user",
        targetId: input.userId,
        projectId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        details: { role: current.name, ...(forced && { last_admin_removed: true }) },
        ...ip(input.sourceIp),
      });
      return { ok: true, member };
    });
  }

  async listIngestionKeys(access: ProjectAccess): Promise<IngestionKeySummary[]> {
    requirePermission(access, "keys.manage");
    const { rows } = await this.pool.query<KeyRow>(
      `SELECT ${KEY_COLUMNS} FROM ingestion_keys WHERE project_id = $1 ORDER BY created_at DESC, key_id`,
      [access.projectId],
    );
    return rows.map(toKey);
  }

  rotateIngestionKey(
    access: ProjectAccess,
    input: {
      keyId: string;
      newKeyId: string;
      newKeyHash: Uint8Array;
      oldExpiresAt: Date;
      now: Date;
      sourceIp?: string;
    },
  ): Promise<Result<{ old: IngestionKeySummary; created: IngestionKeySummary }, "not_found" | "not_active">> {
    requirePermission(access, "keys.manage");
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<KeyRow>(
        `SELECT ${KEY_COLUMNS} FROM ingestion_keys WHERE project_id = $1 AND key_id = $2 FOR UPDATE`,
        [access.projectId, input.keyId],
      );
      const before = rows[0];
      if (!before) return { ok: false, reason: "not_found" };
      if (before.revoked_at !== null || before.expires_at !== null) return { ok: false, reason: "not_active" };
      const created = await client.query<KeyRow>(
        `INSERT INTO ingestion_keys (key_id, project_id, key_hash, name, created_by) VALUES ($1, $2, $3, $4, $5)
         RETURNING ${KEY_COLUMNS}`,
        [input.newKeyId, access.projectId, Buffer.from(input.newKeyHash), before.name, access.userId],
      );
      const old = await client.query<KeyRow>(
        `UPDATE ingestion_keys SET expires_at = $3 WHERE project_id = $1 AND key_id = $2 RETURNING ${KEY_COLUMNS}`,
        [access.projectId, input.keyId, input.oldExpiresAt.toISOString()],
      );
      await insertAudit(client, {
        actorUserId: access.userId,
        action: "ingestion_key.rotated",
        targetType: "ingestion_key",
        targetId: input.keyId,
        projectId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        details: { new_key_id: input.newKeyId, old_key_expires_at: input.oldExpiresAt.toISOString() },
        ...ip(input.sourceIp),
      });
      return {
        ok: true,
        old: toKey(firstRow(old.rows, "expire rotated key")),
        created: toKey(firstRow(created.rows, "insert rotated key")),
      };
    });
  }

  revokeIngestionKey(
    access: ProjectAccess,
    input: { keyId: string; now: Date; sourceIp?: string },
  ): Promise<Result<{ key: IngestionKeySummary }, "not_found" | "already_revoked">> {
    requirePermission(access, "keys.manage");
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<KeyRow>(
        `UPDATE ingestion_keys SET revoked_at = $3 WHERE project_id = $1 AND key_id = $2 AND revoked_at IS NULL
         RETURNING ${KEY_COLUMNS}`,
        [access.projectId, input.keyId, input.now.toISOString()],
      );
      const key = rows[0];
      if (!key) {
        const exists = await client.query("SELECT 1 FROM ingestion_keys WHERE project_id = $1 AND key_id = $2", [
          access.projectId,
          input.keyId,
        ]);
        return { ok: false, reason: exists.rowCount === 1 ? "already_revoked" : "not_found" };
      }
      await insertAudit(client, {
        actorUserId: access.userId,
        action: "ingestion_key.revoked",
        targetType: "ingestion_key",
        targetId: input.keyId,
        projectId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        ...ip(input.sourceIp),
      });
      return { ok: true, key: toKey(key) };
    });
  }
}

async function revokeAllSessions(client: PoolClient, userId: string, now: Date): Promise<number> {
  const { rowCount } = await client.query(
    "UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL",
    [userId, now.toISOString()],
  );
  return rowCount ?? 0;
}

async function revokePendingResets(client: PoolClient, userId: string, now: Date): Promise<void> {
  await client.query(
    `UPDATE account_tokens SET revoked_at = $2
     WHERE purpose = 'password_reset' AND user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
    [userId, now.toISOString()],
  );
}

async function lockProject(client: PoolClient, projectId: string): Promise<void> {
  const { rowCount } = await client.query("SELECT 1 FROM projects WHERE id = $1 FOR UPDATE", [projectId]);
  if (rowCount !== 1) throw new Error("project no longer exists");
}

async function findRole(client: PoolClient, projectId: string, name: string): Promise<RoleRow | undefined> {
  const { rows } = await client.query<RoleRow>(
    "SELECT id, name, permissions, built_in FROM project_roles WHERE project_id = $1 AND lower(name) = lower($2)",
    [projectId, name],
  );
  return rows[0];
}

async function currentRole(client: PoolClient, projectId: string, userId: string): Promise<RoleRow | undefined> {
  if (!isUuid(userId)) return undefined;
  const { rows } = await client.query<RoleRow>(
    `SELECT r.id, r.name, r.permissions, r.built_in FROM project_members m JOIN project_roles r ON r.id = m.role_id
     WHERE m.project_id = $1 AND m.user_id = $2`,
    [projectId, userId],
  );
  return rows[0];
}

async function isLastAdmin(client: PoolClient, projectId: string): Promise<boolean> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM project_members m JOIN project_roles r ON r.id = m.role_id
     WHERE m.project_id = $1 AND r.built_in AND r.name = 'admin'`,
    [projectId],
  );
  return Number(firstRow(rows, "count project admins").n) <= 1;
}

async function getMember(client: PoolClient, projectId: string, userId: string): Promise<MemberRecord> {
  const { rows } = await client.query<MemberRow>(`${MEMBER_SELECT} WHERE m.project_id = $1 AND m.user_id = $2`, [
    projectId,
    userId,
  ]);
  return toMember(firstRow(rows, "read member"));
}
