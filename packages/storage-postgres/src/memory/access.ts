// Test double for PostgresAccessRepository: it must enforce the same rules,
// or API unit tests pass against behaviour production does not have.

import { randomUUID } from "node:crypto";
import { canAssignRole, DEFAULT_PROJECT_ROLES, type ProjectPermission } from "@jekimo/event-schema";
import { assertProjectAccess } from "../access.js";
import type { AccountTokenPurpose } from "../constants/access.js";
import type {
  AccessRepository,
  Actor,
  IngestionKeySummary,
  InstanceRole,
  InvitationRecord,
  MemberRecord,
  PasswordResetRecord,
  ProjectAccess,
  ProjectSettingsChange,
  Result,
  RoleRecord,
  SessionSummary,
  UserRecord,
} from "../types/access.js";
import type { AuditEntry, AuditQuery, AuditRecord } from "../types/audit.js";
import type { MemoryAccountToken, MemoryKey, MemorySession, MemoryUser } from "../types/memory.js";
import type { ProjectRecord } from "../types/projects.js";

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function publicUser(u: MemoryUser): UserRecord {
  const { passwordHash: _, ...user } = u;
  return { ...user };
}

function requireInstanceAdmin(actor: Actor | null): void {
  if (actor !== null && actor.instanceRole !== "admin") throw new Error("instance admin required");
}

function requirePermission(access: ProjectAccess, permission: ProjectPermission): void {
  assertProjectAccess(access);
  if (!access.permissions.has(permission)) throw new Error(`missing permission ${permission}`);
}

function ip(sourceIp: string | undefined): { sourceIp?: string } {
  return sourceIp === undefined ? {} : { sourceIp };
}

function toKey(k: MemoryKey): IngestionKeySummary {
  return {
    keyId: k.keyId,
    name: k.name,
    createdAt: k.createdAt,
    createdBy: k.createdBy ?? null,
    expiresAt: k.expiresAt,
    revokedAt: k.revokedAt,
  };
}

const BUILT_IN = new Set(Object.keys(DEFAULT_PROJECT_ROLES));

export class MemoryAccessRepository implements AccessRepository {
  readonly users: MemoryUser[] = [];
  readonly sessions: MemorySession[] = [];
  readonly projects: ProjectRecord[] = [];
  /** project id -> user id -> role name */
  readonly members = new Map<string, Map<string, string>>();
  /** project id -> role name -> permissions */
  readonly roles = new Map<string, Map<string, Set<ProjectPermission>>>();
  readonly keys: MemoryKey[] = [];
  /** `id` is set by appendAudit; entries pushed directly by tests fall back to their position. */
  readonly audit: (AuditEntry & { occurredAt: Date; id?: number })[] = [];
  readonly tokens: MemoryAccountToken[] = [];
  private auditSeq = 0;

  constructor(protected readonly clock: () => Date = () => new Date()) {}

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.audit.push({ ...entry, occurredAt: this.clock(), id: ++this.auditSeq });
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const u = this.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
    return u ? publicUser(u) : null;
  }

  async listUsers(actor: Actor): Promise<UserRecord[]> {
    requireInstanceAdmin(actor);
    return this.users.map(publicUser);
  }

  async updateUser(
    actor: Actor,
    userId: string,
    change: { instanceRole?: InstanceRole; status?: UserRecord["status"] },
    meta: { now: Date; sourceIp?: string },
  ): Promise<Result<{ user: UserRecord }, "not_found" | "last_admin">> {
    requireInstanceAdmin(actor);
    const u = this.users.find((x) => x.id === userId);
    if (!u) return { ok: false, reason: "not_found" };
    const role = change.instanceRole ?? u.instanceRole;
    const status = change.status ?? u.status;
    const activeAdmins = this.users.filter((x) => x.instanceRole === "admin" && x.status === "active").length;
    const wasActiveAdmin = u.instanceRole === "admin" && u.status === "active";
    if (wasActiveAdmin && !(role === "admin" && status === "active") && activeAdmins <= 1)
      return { ok: false, reason: "last_admin" };
    const audit = { actorUserId: actor.userId, targetType: "user", targetId: userId, ...ip(meta.sourceIp) };
    if (role !== u.instanceRole) {
      await this.appendAudit({
        ...audit,
        action: "user.role_changed",
        details: { before: u.instanceRole, after: role },
      });
      u.instanceRole = role;
    }
    if (status !== u.status) {
      u.status = status;
      if (status === "deactivated") {
        const revoked = this.revokeAll(userId, meta.now);
        await this.appendAudit({ ...audit, action: "user.deactivated", details: { sessions_revoked: revoked } });
      } else {
        await this.appendAudit({ ...audit, action: "user.reactivated" });
      }
    }
    return { ok: true, user: publicUser(u) };
  }

  private revokeAll(userId: string, now: Date, exceptSessionId?: string): number {
    let n = 0;
    for (const s of this.sessions) {
      if (s.userId === userId && s.revokedAt === null && s.id !== exceptSessionId) {
        s.revokedAt = now;
        n++;
      }
    }
    return n;
  }

  async listSessions(userId: string, now: Date): Promise<SessionSummary[]> {
    return this.sessions
      .filter((s) => s.userId === userId && s.revokedAt === null && s.expiresAt > now)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .map((s) => ({
        sessionId: s.id,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        sourceIp: null,
        userAgent: null,
      }));
  }

  async revokeOwnSession(userId: string, sessionId: string, meta: { now: Date; sourceIp?: string }): Promise<boolean> {
    const s = this.sessions.find((x) => x.id === sessionId && x.userId === userId);
    if (!s || s.revokedAt !== null || s.expiresAt <= meta.now) return false;
    s.revokedAt = meta.now;
    await this.appendAudit({
      actorUserId: userId,
      action: "session.revoked",
      targetType: "user",
      targetId: userId,
      details: { session_id: sessionId },
      ...ip(meta.sourceIp),
    });
    return true;
  }

  async revokeUserSessions(actor: Actor, userId: string, meta: { now: Date; sourceIp?: string }): Promise<number> {
    requireInstanceAdmin(actor);
    const revoked = this.revokeAll(userId, meta.now);
    await this.appendAudit({
      actorUserId: actor.userId,
      action: "session.revoked",
      targetType: "user",
      targetId: userId,
      details: { sessions_revoked: revoked },
      ...ip(meta.sourceIp),
    });
    return revoked;
  }

  async changePassword(
    userId: string,
    passwordHash: string,
    meta: { now: Date; keepSessionId: string; sourceIp?: string },
  ): Promise<void> {
    const u = this.users.find((x) => x.id === userId);
    if (!u) throw new Error(`no user ${userId}`);
    u.passwordHash = passwordHash;
    const revoked = this.revokeAll(userId, meta.now, meta.keepSessionId);
    for (const t of this.tokens) {
      if (t.purpose === "password_reset" && t.userId === userId && t.usedAt === null && t.revokedAt === null)
        t.revokedAt = meta.now;
    }
    await this.appendAudit({
      actorUserId: userId,
      action: "user.password_changed",
      targetType: "user",
      targetId: userId,
      details: { sessions_revoked: revoked },
      ...ip(meta.sourceIp),
    });
  }

  private pending(purpose: AccountTokenPurpose, tokenHash: Uint8Array, now: Date): MemoryAccountToken | undefined {
    return this.tokens.find(
      (t) =>
        t.purpose === purpose &&
        sameBytes(t.tokenHash, tokenHash) &&
        t.usedAt === null &&
        t.revokedAt === null &&
        t.expiresAt > now,
    );
  }

  async createInvitation(
    actor: Actor,
    input: { email: string; instanceRole: InstanceRole; tokenHash: Uint8Array; expiresAt: Date; sourceIp?: string },
  ): Promise<Result<{ invitation: InvitationRecord }, "email_taken">> {
    requireInstanceAdmin(actor);
    const email = input.email.toLowerCase();
    if (this.users.some((u) => u.email.toLowerCase() === email)) return { ok: false, reason: "email_taken" };
    const now = this.clock();
    for (const t of this.tokens) {
      if (t.purpose === "invitation" && t.email?.toLowerCase() === email && t.usedAt === null && t.revokedAt === null)
        t.revokedAt = now;
    }
    const token: MemoryAccountToken = {
      id: randomUUID(),
      purpose: "invitation",
      tokenHash: input.tokenHash,
      email: input.email,
      instanceRole: input.instanceRole,
      userId: null,
      createdBy: actor.userId,
      createdAt: now,
      expiresAt: input.expiresAt,
      usedAt: null,
      revokedAt: null,
    };
    this.tokens.push(token);
    await this.appendAudit({
      actorUserId: actor.userId,
      action: "user.invited",
      targetType: "invitation",
      targetId: token.id,
      details: { email: input.email, instance_role: input.instanceRole },
      ...ip(input.sourceIp),
    });
    return { ok: true, invitation: this.toInvitation(token) };
  }

  private toInvitation(t: MemoryAccountToken): InvitationRecord {
    return {
      id: t.id,
      email: t.email ?? "",
      instanceRole: t.instanceRole ?? "member",
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
    };
  }

  async listInvitations(actor: Actor, now: Date): Promise<InvitationRecord[]> {
    requireInstanceAdmin(actor);
    return this.tokens
      .filter((t) => t.purpose === "invitation" && t.usedAt === null && t.revokedAt === null && t.expiresAt > now)
      .map((t) => this.toInvitation(t));
  }

  async revokeInvitation(actor: Actor, invitationId: string, meta: { now: Date; sourceIp?: string }): Promise<boolean> {
    requireInstanceAdmin(actor);
    const t = this.tokens.find(
      (x) =>
        x.id === invitationId &&
        x.purpose === "invitation" &&
        x.usedAt === null &&
        x.revokedAt === null &&
        x.expiresAt > meta.now,
    );
    if (!t) return false;
    t.revokedAt = meta.now;
    await this.appendAudit({
      actorUserId: actor.userId,
      action: "user.invitation_revoked",
      targetType: "invitation",
      targetId: invitationId,
      details: { email: t.email },
      ...ip(meta.sourceIp),
    });
    return true;
  }

  async acceptInvitation(
    tokenHash: Uint8Array,
    passwordHash: string,
    meta: { now: Date; sourceIp?: string },
  ): Promise<Result<{ user: UserRecord }, "invalid_token" | "email_taken">> {
    const t = this.pending("invitation", tokenHash, meta.now);
    if (!t || t.email === null || t.instanceRole === null) return { ok: false, reason: "invalid_token" };
    const email = t.email;
    if (this.users.some((u) => u.email.toLowerCase() === email.toLowerCase()))
      return { ok: false, reason: "email_taken" };
    const u: MemoryUser = {
      id: randomUUID(),
      email,
      passwordHash,
      instanceRole: t.instanceRole,
      status: "active",
      createdAt: this.clock(),
    };
    this.users.push(u);
    t.usedAt = meta.now;
    await this.appendAudit({
      actorUserId: u.id,
      action: "user.activated",
      targetType: "user",
      targetId: u.id,
      details: { invitation_id: t.id, instance_role: u.instanceRole, invited_by: t.createdBy },
      ...ip(meta.sourceIp),
    });
    return { ok: true, user: publicUser(u) };
  }

  async createPasswordReset(
    actor: Actor | null,
    input: { userId: string; tokenHash: Uint8Array; expiresAt: Date; sourceIp?: string },
  ): Promise<Result<{ reset: PasswordResetRecord }, "not_found">> {
    requireInstanceAdmin(actor);
    if (!this.users.some((u) => u.id === input.userId)) return { ok: false, reason: "not_found" };
    const now = this.clock();
    for (const t of this.tokens) {
      if (t.purpose === "password_reset" && t.userId === input.userId && t.usedAt === null && t.revokedAt === null)
        t.revokedAt = now;
    }
    const token: MemoryAccountToken = {
      id: randomUUID(),
      purpose: "password_reset",
      tokenHash: input.tokenHash,
      email: null,
      instanceRole: null,
      userId: input.userId,
      createdBy: actor?.userId ?? null,
      createdAt: now,
      expiresAt: input.expiresAt,
      usedAt: null,
      revokedAt: null,
    };
    this.tokens.push(token);
    await this.appendAudit({
      actorUserId: actor?.userId ?? null,
      action: "user.password_reset_link_created",
      targetType: "user",
      targetId: input.userId,
      details: { reset_id: token.id, via: actor === null ? "cli" : "api" },
      ...ip(input.sourceIp),
    });
    return { ok: true, reset: { id: token.id, userId: input.userId, createdAt: now, expiresAt: input.expiresAt } };
  }

  async resetPassword(
    tokenHash: Uint8Array,
    passwordHash: string,
    meta: { now: Date; sourceIp?: string },
  ): Promise<Result<{ user: UserRecord }, "invalid_token">> {
    const t = this.pending("password_reset", tokenHash, meta.now);
    const u = t && this.users.find((x) => x.id === t.userId);
    if (!t || !u) return { ok: false, reason: "invalid_token" };
    u.passwordHash = passwordHash;
    t.usedAt = meta.now;
    const revoked = this.revokeAll(u.id, meta.now);
    await this.appendAudit({
      actorUserId: u.id,
      action: "user.password_reset",
      targetType: "user",
      targetId: u.id,
      details: { reset_id: t.id, sessions_revoked: revoked },
      ...ip(meta.sourceIp),
    });
    return { ok: true, user: publicUser(u) };
  }

  async listAudit(actor: Actor, query: AuditQuery): Promise<AuditRecord[]> {
    requireInstanceAdmin(actor);
    const out: AuditRecord[] = [];
    for (let i = this.audit.length - 1; i >= 0 && out.length < query.limit; i--) {
      const a = this.audit[i];
      if (!a) continue;
      const id = a.id ?? i + 1;
      if (query.beforeId !== undefined && id >= Number(query.beforeId)) continue;
      if (query.actorUserId !== undefined && a.actorUserId !== query.actorUserId) continue;
      if (query.action !== undefined && a.action !== query.action) continue;
      if (query.from !== undefined && a.occurredAt < query.from) continue;
      if (query.to !== undefined && a.occurredAt >= query.to) continue;
      out.push({
        id: String(id),
        occurredAt: a.occurredAt,
        actorUserId: a.actorUserId ?? null,
        actorEmail: this.users.find((u) => u.id === a.actorUserId)?.email ?? null,
        action: a.action,
        targetType: a.targetType ?? null,
        targetId: a.targetId ?? null,
        projectId: a.projectId ?? null,
        sourceIp: a.sourceIp ?? null,
        viaInstanceAdmin: a.viaInstanceAdmin ?? false,
        details: structuredClone(a.details ?? {}),
      });
    }
    return out;
  }

  async pruneAudit(before: Date): Promise<number> {
    const kept = this.audit.filter((a) => a.occurredAt >= before);
    const pruned = this.audit.length - kept.length;
    this.audit.splice(0, this.audit.length, ...kept);
    return pruned;
  }

  async updateProject(access: ProjectAccess, change: ProjectSettingsChange, sourceIp?: string): Promise<ProjectRecord> {
    requirePermission(access, "settings.manage");
    const p = this.projects.find((x) => x.id === access.projectId);
    if (!p) throw new Error("project no longer exists");
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    if (change.name !== undefined && change.name !== p.name) changes.name = { before: p.name, after: change.name };
    if (change.retentionDays !== undefined && change.retentionDays !== p.retentionDays)
      changes.retention_days = { before: p.retentionDays, after: change.retentionDays };
    if (change.sampleRate !== undefined && change.sampleRate !== p.sampleRate)
      changes.sample_rate = { before: p.sampleRate, after: change.sampleRate };
    if (Object.keys(changes).length === 0) return { ...p };
    Object.assign(p, change);
    await this.appendAudit({
      actorUserId: access.userId,
      action: "project.settings_updated",
      targetType: "project",
      targetId: access.projectId,
      projectId: access.projectId,
      viaInstanceAdmin: access.viaInstanceAdmin,
      details: { changes },
      ...ip(sourceIp),
    });
    return { ...p };
  }

  private role(projectId: string, name: string): { name: string; permissions: Set<ProjectPermission> } | undefined {
    for (const [n, permissions] of this.roles.get(projectId) ?? []) {
      if (n.toLowerCase() === name.toLowerCase()) return { name: n, permissions };
    }
    return undefined;
  }

  private member(projectId: string, userId: string): MemberRecord | undefined {
    const role = this.members.get(projectId)?.get(userId);
    const u = this.users.find((x) => x.id === userId);
    if (role === undefined || !u) return undefined;
    return {
      userId,
      email: u.email,
      status: u.status,
      role,
      isAdmin: role === "admin",
      createdAt: u.createdAt,
    };
  }

  private isLastAdmin(projectId: string): boolean {
    return [...(this.members.get(projectId)?.values() ?? [])].filter((r) => r === "admin").length <= 1;
  }

  async listRoles(access: ProjectAccess): Promise<RoleRecord[]> {
    requirePermission(access, "project.read");
    const members = [...(this.members.get(access.projectId)?.values() ?? [])];
    return [...(this.roles.get(access.projectId) ?? [])]
      .map(([name, permissions]) => ({
        name,
        description: null,
        permissions: [...permissions],
        builtIn: BUILT_IN.has(name),
        memberCount: members.filter((r) => r === name).length,
      }))
      .sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || (a.builtIn ? 0 : a.name.localeCompare(b.name)));
  }

  async listMembers(access: ProjectAccess): Promise<MemberRecord[]> {
    requirePermission(access, "project.read");
    return [...(this.members.get(access.projectId)?.keys() ?? [])]
      .map((userId) => this.member(access.projectId, userId))
      .filter((m): m is MemberRecord => m !== undefined);
  }

  async addMember(
    access: ProjectAccess,
    input: { userId: string; role: string; sourceIp?: string },
  ): Promise<Result<{ member: MemberRecord }, "user_not_found" | "already_member" | "unknown_role" | "escalation">> {
    requirePermission(access, "members.manage");
    const role = this.role(access.projectId, input.role);
    if (!role) return { ok: false, reason: "unknown_role" };
    if (!canAssignRole(access.permissions, role)) return { ok: false, reason: "escalation" };
    if (!this.users.some((u) => u.id === input.userId)) return { ok: false, reason: "user_not_found" };
    const members = this.members.get(access.projectId);
    if (!members) throw new Error("project no longer exists");
    if (members.has(input.userId)) return { ok: false, reason: "already_member" };
    members.set(input.userId, role.name);
    await this.appendAudit({
      actorUserId: access.userId,
      action: "member.added",
      targetType: "user",
      targetId: input.userId,
      projectId: access.projectId,
      viaInstanceAdmin: access.viaInstanceAdmin,
      details: { role: role.name },
      ...ip(input.sourceIp),
    });
    return { ok: true, member: this.member(access.projectId, input.userId) as MemberRecord };
  }

  async changeMemberRole(
    access: ProjectAccess,
    input: { userId: string; role: string; force?: boolean; sourceIp?: string },
  ): Promise<Result<{ member: MemberRecord }, "not_member" | "unknown_role" | "escalation" | "last_admin">> {
    requirePermission(access, "members.manage");
    const currentName = this.members.get(access.projectId)?.get(input.userId);
    const current = currentName === undefined ? undefined : this.role(access.projectId, currentName);
    if (!current) return { ok: false, reason: "not_member" };
    const role = this.role(access.projectId, input.role);
    if (!role) return { ok: false, reason: "unknown_role" };
    if (role.name === current.name)
      return { ok: true, member: this.member(access.projectId, input.userId) as MemberRecord };
    if (!canAssignRole(access.permissions, current) || !canAssignRole(access.permissions, role))
      return { ok: false, reason: "escalation" };
    const forced = current.name === "admin" && role.name !== "admin" && this.isLastAdmin(access.projectId);
    if (forced && input.force !== true) return { ok: false, reason: "last_admin" };
    this.members.get(access.projectId)?.set(input.userId, role.name);
    await this.appendAudit({
      actorUserId: access.userId,
      action: "member.role_changed",
      targetType: "user",
      targetId: input.userId,
      projectId: access.projectId,
      viaInstanceAdmin: access.viaInstanceAdmin,
      details: { before: current.name, after: role.name, ...(forced && { last_admin_removed: true }) },
      ...ip(input.sourceIp),
    });
    return { ok: true, member: this.member(access.projectId, input.userId) as MemberRecord };
  }

  async removeMember(
    access: ProjectAccess,
    input: { userId: string; force?: boolean; sourceIp?: string },
  ): Promise<Result<{ member: MemberRecord }, "not_member" | "escalation" | "last_admin">> {
    requirePermission(access, "members.manage");
    const member = this.member(access.projectId, input.userId);
    const current = member && this.role(access.projectId, member.role);
    if (!member || !current) return { ok: false, reason: "not_member" };
    if (!canAssignRole(access.permissions, current)) return { ok: false, reason: "escalation" };
    const forced = current.name === "admin" && this.isLastAdmin(access.projectId);
    if (forced && input.force !== true) return { ok: false, reason: "last_admin" };
    this.members.get(access.projectId)?.delete(input.userId);
    await this.appendAudit({
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
  }

  async listIngestionKeys(access: ProjectAccess): Promise<IngestionKeySummary[]> {
    requirePermission(access, "keys.manage");
    return this.keys
      .filter((k) => k.projectId === access.projectId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.keyId < b.keyId ? -1 : 1))
      .map(toKey);
  }

  async rotateIngestionKey(
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
    const old = this.keys.find((k) => k.projectId === access.projectId && k.keyId === input.keyId);
    if (!old) return { ok: false, reason: "not_found" };
    if (old.revokedAt !== null || old.expiresAt !== null) return { ok: false, reason: "not_active" };
    const created: MemoryKey = {
      keyId: input.newKeyId,
      projectId: access.projectId,
      keyHash: input.newKeyHash,
      revokedAt: null,
      expiresAt: null,
      projectDisabled: false,
      name: old.name,
      createdAt: input.now,
      createdBy: access.userId,
    };
    this.keys.push(created);
    old.expiresAt = input.oldExpiresAt;
    await this.appendAudit({
      actorUserId: access.userId,
      action: "ingestion_key.rotated",
      targetType: "ingestion_key",
      targetId: input.keyId,
      projectId: access.projectId,
      viaInstanceAdmin: access.viaInstanceAdmin,
      details: { new_key_id: input.newKeyId, old_key_expires_at: input.oldExpiresAt.toISOString() },
      ...ip(input.sourceIp),
    });
    return { ok: true, old: toKey(old), created: toKey(created) };
  }

  async revokeIngestionKey(
    access: ProjectAccess,
    input: { keyId: string; now: Date; sourceIp?: string },
  ): Promise<Result<{ key: IngestionKeySummary }, "not_found" | "already_revoked">> {
    requirePermission(access, "keys.manage");
    const key = this.keys.find((k) => k.projectId === access.projectId && k.keyId === input.keyId);
    if (!key) return { ok: false, reason: "not_found" };
    if (key.revokedAt !== null) return { ok: false, reason: "already_revoked" };
    key.revokedAt = input.now;
    await this.appendAudit({
      actorUserId: access.userId,
      action: "ingestion_key.revoked",
      targetType: "ingestion_key",
      targetId: input.keyId,
      projectId: access.projectId,
      viaInstanceAdmin: access.viaInstanceAdmin,
      ...ip(input.sourceIp),
    });
    return { ok: true, key: toKey(key) };
  }
}
