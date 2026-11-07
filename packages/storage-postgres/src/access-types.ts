/**
 * Types for users, invitations, memberships, ingestion key management, and
 * the audit log (docs/access-model.md). MetadataRepository extends
 * AccessRepository, so both storage implementations provide these.
 */

import type { ProjectPermission } from "@jekimo/event-schema";
import type { ProjectAccess } from "./access.js";
import type { Actor, InstanceRole, ProjectRecord, UserRecord } from "./types.js";

/**
 * Every action the audit log records (docs/access-model.md, "Audit log").
 * Some have no route yet (project deletion, custom roles, bulk deletion,
 * instance settings); they are listed so the vocabulary is fixed up front.
 */
export const AUDIT_ACTIONS = [
  // Sign-in and sessions.
  "auth.login",
  "auth.login_failed",
  "auth.login_locked",
  "auth.logout",
  "session.revoked",
  "user.password_changed",
  // Users.
  "user.created",
  "user.invited",
  "user.invitation_revoked",
  "user.activated",
  "user.deactivated",
  "user.reactivated",
  "user.role_changed",
  "user.password_reset_link_created",
  "user.password_reset",
  // Projects. Retention and sample rate changes are project.settings_updated
  // with the before and after values.
  "project.created",
  "project.settings_updated",
  "project.redaction_rules_updated",
  "project.deleted",
  "project.restored",
  // Memberships.
  "member.added",
  "member.role_changed",
  "member.removed",
  // Custom roles.
  "role.created",
  "role.updated",
  "role.deleted",
  // Ingestion keys.
  "ingestion_key.created",
  "ingestion_key.rotated",
  "ingestion_key.revoked",
  // Data and instance.
  "data.bulk_deleted",
  "instance.settings_updated",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/** One stored audit entry, as listed to instance admins. */
export interface AuditRecord {
  /** Increasing; also the paging cursor. */
  id: string;
  occurredAt: Date;
  actorUserId: string | null;
  /** The actor's current email, or null when the user was deleted. */
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  projectId: string | null;
  sourceIp: string | null;
  viaInstanceAdmin: boolean;
  details: Record<string, unknown>;
}

export interface AuditQuery {
  actorUserId?: string;
  action?: string;
  /** Inclusive lower bound on occurred_at. */
  from?: Date;
  /** Exclusive upper bound on occurred_at. */
  to?: Date;
  /** Entries with an id below this one: the previous page's last id. */
  beforeId?: string;
  limit: number;
}

export interface SessionSummary {
  sessionId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  sourceIp: string | null;
  userAgent: string | null;
}

export type AccountTokenPurpose = "invitation" | "password_reset";

export interface InvitationRecord {
  id: string;
  email: string;
  instanceRole: InstanceRole;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface PasswordResetRecord {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface RoleRecord {
  name: string;
  description: string | null;
  permissions: ProjectPermission[];
  builtIn: boolean;
  memberCount: number;
}

export interface MemberRecord {
  userId: string;
  email: string;
  status: UserRecord["status"];
  role: string;
  /** True when the role is the built-in admin role. */
  isAdmin: boolean;
  createdAt: Date;
}

export type IngestionKeyStatus = "active" | "rotating" | "expired" | "revoked";

export interface IngestionKeySummary {
  keyId: string;
  name: string;
  createdAt: Date;
  createdBy: string | null;
  /** Set when the key was rotated: it stops working at this time. */
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** Failure reasons are stable strings that the API maps to error codes. */
export type Result<T, Reason extends string> = ({ ok: true } & T) | { ok: false; reason: Reason };

export interface ProjectSettingsChange {
  name?: string;
  retentionDays?: number;
  sampleRate?: number;
}

export interface AccessRepository {
  // Users (instance-level).
  findUserByEmail(email: string): Promise<UserRecord | null>;
  /** Instance admins only. */
  listUsers(actor: Actor): Promise<UserRecord[]>;
  /**
   * Instance admins only. Deactivating revokes the user's sessions. Keeps at
   * least one active instance admin.
   */
  updateUser(
    actor: Actor,
    userId: string,
    change: { instanceRole?: InstanceRole; status?: UserRecord["status"] },
    meta: { now: Date; sourceIp?: string },
  ): Promise<Result<{ user: UserRecord }, "not_found" | "last_admin">>;

  // Sessions.
  listSessions(userId: string, now: Date): Promise<SessionSummary[]>;
  /** Revokes one of the user's own sessions. False when it is not theirs or not live. */
  revokeOwnSession(userId: string, sessionId: string, meta: { now: Date; sourceIp?: string }): Promise<boolean>;
  /** Revokes every live session of `userId`; returns how many. Audit-logged as the actor's action. */
  revokeUserSessions(actor: Actor, userId: string, meta: { now: Date; sourceIp?: string }): Promise<number>;
  /** Sets a new password hash and revokes the user's other sessions. */
  changePassword(
    userId: string,
    passwordHash: string,
    meta: { now: Date; keepSessionId: string; sourceIp?: string },
  ): Promise<void>;

  // Invitations and password reset links. Tokens are stored as SHA-256 hashes.
  /**
   * Instance admins only. Replaces any pending invitation for the same email.
   * `email_taken` when a user with that email exists.
   */
  createInvitation(
    actor: Actor,
    input: { email: string; instanceRole: InstanceRole; tokenHash: Uint8Array; expiresAt: Date; sourceIp?: string },
  ): Promise<Result<{ invitation: InvitationRecord }, "email_taken">>;
  /** Pending invitations: not used, revoked, or expired. Instance admins only. */
  listInvitations(actor: Actor, now: Date): Promise<InvitationRecord[]>;
  revokeInvitation(actor: Actor, invitationId: string, meta: { now: Date; sourceIp?: string }): Promise<boolean>;
  /** Creates the user and uses up the token, atomically. */
  acceptInvitation(
    tokenHash: Uint8Array,
    passwordHash: string,
    meta: { now: Date; sourceIp?: string },
  ): Promise<Result<{ user: UserRecord }, "invalid_token" | "email_taken">>;
  /**
   * Replaces any pending reset link for the user. `actor` is null when the
   * link comes from the command line on the server.
   */
  createPasswordReset(
    actor: Actor | null,
    input: { userId: string; tokenHash: Uint8Array; expiresAt: Date; sourceIp?: string },
  ): Promise<Result<{ reset: PasswordResetRecord }, "not_found">>;
  /** Sets the password, uses up the token, and revokes every session of the user. */
  resetPassword(
    tokenHash: Uint8Array,
    passwordHash: string,
    meta: { now: Date; sourceIp?: string },
  ): Promise<Result<{ user: UserRecord }, "invalid_token">>;

  // Audit log.
  /** Instance admins only. Newest first. */
  listAudit(actor: Actor, query: AuditQuery): Promise<AuditRecord[]>;
  /** Deletes entries that occurred before `before`; returns how many. */
  pruneAudit(before: Date): Promise<number>;

  // Project settings, roles, and memberships.
  /** Requires settings.manage. Audit-logs changed fields with before and after values. */
  updateProject(access: ProjectAccess, change: ProjectSettingsChange, sourceIp?: string): Promise<ProjectRecord>;
  listRoles(access: ProjectAccess): Promise<RoleRecord[]>;
  listMembers(access: ProjectAccess): Promise<MemberRecord[]>;
  /**
   * Requires members.manage. Enforces the no-escalation rule
   * (canAssignRole) on the role being granted.
   */
  addMember(
    access: ProjectAccess,
    input: { userId: string; role: string; sourceIp?: string },
  ): Promise<Result<{ member: MemberRecord }, "user_not_found" | "already_member" | "unknown_role" | "escalation">>;
  /**
   * Requires members.manage. The actor must be able to assign both the old
   * and the new role. The last built-in admin can only lose that role when
   * the actor is an instance admin and passes `force`.
   */
  changeMemberRole(
    access: ProjectAccess,
    input: { userId: string; role: string; force?: boolean; sourceIp?: string },
  ): Promise<Result<{ member: MemberRecord }, "not_member" | "unknown_role" | "escalation" | "last_admin">>;
  /** Requires members.manage. Same escalation and last-admin rules as changeMemberRole. */
  removeMember(
    access: ProjectAccess,
    input: { userId: string; force?: boolean; sourceIp?: string },
  ): Promise<Result<{ member: MemberRecord }, "not_member" | "escalation" | "last_admin">>;

  // Ingestion key management.
  /** Requires keys.manage. Never returns hashes or secrets. */
  listIngestionKeys(access: ProjectAccess): Promise<IngestionKeySummary[]>;
  /**
   * Requires keys.manage. Stores a new key with the old key's name and makes
   * the old key expire at `oldExpiresAt`. Only active keys can be rotated.
   */
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
  ): Promise<Result<{ old: IngestionKeySummary; created: IngestionKeySummary }, "not_found" | "not_active">>;
  /** Requires keys.manage. Takes effect on the next ingest request. */
  revokeIngestionKey(
    access: ProjectAccess,
    input: { keyId: string; now: Date; sourceIp?: string },
  ): Promise<Result<{ key: IngestionKeySummary }, "not_found" | "already_revoked">>;
}

/** Status of a key at `now`. */
export function ingestionKeyStatus(key: IngestionKeySummary, now: Date): IngestionKeyStatus {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt === null) return "active";
  return key.expiresAt > now ? "rotating" : "expired";
}
