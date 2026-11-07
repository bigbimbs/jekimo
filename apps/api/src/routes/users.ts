import { TIMESTAMP_PATTERN } from "@jekimo/event-schema";
import {
  type AuditRecord,
  type InstanceRole,
  type InvitationRecord,
  isAuditAction,
  type UserRecord,
} from "@jekimo/storage-postgres";
import type { FastifyInstance } from "fastify";
import { accountLink, newAccountToken } from "../account-links.js";
import { ApiError } from "../errors.js";
import { actorOf, requireInstanceAdmin } from "../session.js";
import type { UserRouteOptions } from "../types/index.js";
import { publicAccountUser } from "./account.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function body(request: { body: unknown }): Record<string, unknown> {
  return (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
}

function instanceRole(value: unknown, fallback?: InstanceRole): InstanceRole {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === "admin" || value === "member") return value;
  throw new ApiError(400, "invalid_request", "instance_role must be admin or member");
}

function publicInvitation(i: InvitationRecord) {
  return {
    id: i.id,
    email: i.email,
    instance_role: i.instanceRole,
    created_by: i.createdBy,
    created_at: i.createdAt.toISOString(),
    expires_at: i.expiresAt.toISOString(),
  };
}

function publicAudit(a: AuditRecord) {
  return {
    id: a.id,
    occurred_at: a.occurredAt.toISOString(),
    actor: a.actorUserId === null ? null : { user_id: a.actorUserId, email: a.actorEmail },
    action: a.action,
    target: a.targetType === null ? null : { type: a.targetType, id: a.targetId },
    project_id: a.projectId,
    source_ip: a.sourceIp,
    via_instance_admin: a.viaInstanceAdmin,
    details: a.details,
  };
}

function parseTime(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, "invalid_request", `${name} must be an RFC 3339 timestamp`);
  }
  return new Date(value);
}

const userNotFound = () => new ApiError(404, "user_not_found", "user not found");

export async function userRoutes(app: FastifyInstance, opts: UserRouteOptions): Promise<void> {
  const admin = { preHandler: [opts.session, requireInstanceAdmin] };
  const expiry = () => new Date(opts.clock().getTime() + opts.inviteExpiryDays * DAY_MS);

  app.get("/api/v1/users", admin, async (request) => ({
    users: (await opts.metadata.listUsers(actorOf(request))).map(publicAccountUser),
  }));

  app.patch("/api/v1/users/:user_id", admin, async (request) => {
    const { user_id: userId } = request.params as { user_id: string };
    const b = body(request);
    const change: { instanceRole?: InstanceRole; status?: UserRecord["status"] } = {};
    if (b.instance_role !== undefined) change.instanceRole = instanceRole(b.instance_role);
    if (b.status !== undefined) {
      if (b.status !== "active" && b.status !== "deactivated")
        throw new ApiError(400, "invalid_request", "status must be active or deactivated");
      change.status = b.status;
    }
    if (change.instanceRole === undefined && change.status === undefined)
      throw new ApiError(400, "invalid_request", "nothing to change: send instance_role or status");
    const result = await opts.metadata.updateUser(actorOf(request), userId, change, {
      now: opts.clock(),
      sourceIp: request.ip,
    });
    if (!result.ok) {
      if (result.reason === "last_admin")
        throw new ApiError(409, "last_admin", "an instance must keep at least one active admin");
      throw userNotFound();
    }
    return { user: publicAccountUser(result.user) };
  });

  app.delete("/api/v1/users/:user_id/sessions", admin, async (request) => {
    const { user_id: userId } = request.params as { user_id: string };
    if (!UUID.test(userId)) throw userNotFound();
    const revoked = await opts.metadata.revokeUserSessions(actorOf(request), userId, {
      now: opts.clock(),
      sourceIp: request.ip,
    });
    return { revoked };
  });

  app.post("/api/v1/users/:user_id/password-reset", admin, async (request, reply) => {
    const { user_id: userId } = request.params as { user_id: string };
    const { token, tokenHash } = newAccountToken();
    const result = await opts.metadata.createPasswordReset(actorOf(request), {
      userId,
      tokenHash,
      expiresAt: expiry(),
      sourceIp: request.ip,
    });
    if (!result.ok) throw userNotFound();
    reply.status(201).send({
      reset: {
        id: result.reset.id,
        user_id: result.reset.userId,
        created_at: result.reset.createdAt.toISOString(),
        expires_at: result.reset.expiresAt.toISOString(),
      },
      token,
      link: accountLink(opts.publicUrl, "reset-password", token),
      notice: "This link is shown once and works once. Hand it to the user over a channel you trust.",
    });
  });

  app.post("/api/v1/invitations", admin, async (request, reply) => {
    const b = body(request);
    const email = typeof b.email === "string" ? b.email.trim() : "";
    if (email.length > 254 || !EMAIL.test(email))
      throw new ApiError(400, "invalid_request", "a valid email is required");
    const role = instanceRole(b.instance_role, "member");
    const { token, tokenHash } = newAccountToken();
    const result = await opts.metadata.createInvitation(actorOf(request), {
      email,
      instanceRole: role,
      tokenHash,
      expiresAt: expiry(),
      sourceIp: request.ip,
    });
    if (!result.ok) throw new ApiError(409, "email_taken", "an account with this email already exists");
    reply.status(201).send({
      invitation: publicInvitation(result.invitation),
      token,
      link: accountLink(opts.publicUrl, "invite", token),
      notice: "This link is shown once and works once. Hand it to the person over a channel you trust.",
    });
  });

  app.get("/api/v1/invitations", admin, async (request) => ({
    invitations: (await opts.metadata.listInvitations(actorOf(request), opts.clock())).map(publicInvitation),
  }));

  app.delete("/api/v1/invitations/:invitation_id", admin, async (request, reply) => {
    const { invitation_id: id } = request.params as { invitation_id: string };
    const revoked = await opts.metadata.revokeInvitation(actorOf(request), id, {
      now: opts.clock(),
      sourceIp: request.ip,
    });
    if (!revoked) throw new ApiError(404, "not_found", "invitation not found");
    reply.status(204).send();
  });

  app.get("/api/v1/audit-log", admin, async (request) => {
    const q = request.query as Record<string, unknown>;
    const actor = q.actor === undefined ? undefined : String(q.actor);
    if (actor !== undefined && !UUID.test(actor)) throw new ApiError(400, "invalid_request", "actor must be a user id");
    if (q.action !== undefined && !isAuditAction(q.action))
      throw new ApiError(400, "invalid_request", "action is not a known audit action");
    const from = parseTime(q.from, "from");
    const to = parseTime(q.to, "to");
    if (from && to && from >= to) throw new ApiError(400, "invalid_request", "from must be before to");
    const limit = q.limit === undefined ? DEFAULT_AUDIT_LIMIT : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_LIMIT) {
      throw new ApiError(400, "invalid_request", `limit must be a whole number from 1 to ${MAX_AUDIT_LIMIT}`);
    }
    const cursor = q.cursor === undefined ? undefined : String(q.cursor);
    if (cursor !== undefined && !/^[1-9][0-9]{0,17}$/.test(cursor))
      throw new ApiError(400, "invalid_request", "cursor is not valid");
    const entries = await opts.metadata.listAudit(actorOf(request), {
      limit: limit + 1,
      ...(actor !== undefined && { actorUserId: actor }),
      ...(isAuditAction(q.action) && { action: q.action }),
      ...(from && { from }),
      ...(to && { to }),
      ...(cursor !== undefined && { beforeId: cursor }),
    });
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map(publicAudit),
      ...(entries.length > limit && last && { next_cursor: last.id }),
    };
  });
}
