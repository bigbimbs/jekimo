import { type AuditRecord, type InstanceRole, type InvitationRecord, isAuditAction } from "@jekimo/storage-postgres";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_AUDIT_LIMIT,
  EMAIL_PATTERN,
  MAX_AUDIT_LIMIT,
  MAX_EMAIL_CHARS,
  UUID_PATTERN,
} from "../../constants/index.js";
import { ApiError } from "../../errors.js";
import { publicAccountUser } from "../../presenters.js";
import { bodyOf, parseCursor, parseLimit, parseTime } from "../../request.js";
import { actorOf, requireInstanceAdmin } from "../../session.js";
import type { UserChange, UserRouteOptions } from "../../types/index.js";

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

export async function userRoutes(app: FastifyInstance, opts: UserRouteOptions): Promise<void> {
  const { service } = opts;
  const admin = { preHandler: [opts.session, requireInstanceAdmin] };

  app.get("/api/v1/users", admin, async (request) => ({
    users: (await service.listUsers(actorOf(request))).map(publicAccountUser),
  }));

  app.patch("/api/v1/users/:user_id", admin, async (request) => {
    const { user_id: userId } = request.params as { user_id: string };
    const b = bodyOf(request);
    const change: UserChange = {};
    if (b.instance_role !== undefined) change.instanceRole = instanceRole(b.instance_role);
    if (b.status !== undefined) {
      if (b.status !== "active" && b.status !== "deactivated")
        throw new ApiError(400, "invalid_request", "status must be active or deactivated");
      change.status = b.status;
    }
    if (change.instanceRole === undefined && change.status === undefined)
      throw new ApiError(400, "invalid_request", "nothing to change: send instance_role or status");
    const user = await service.updateUser(actorOf(request), userId, change, request.ip);
    return { user: publicAccountUser(user) };
  });

  app.delete("/api/v1/users/:user_id/sessions", admin, async (request) => {
    const { user_id: userId } = request.params as { user_id: string };
    if (!UUID_PATTERN.test(userId)) throw new ApiError(404, "user_not_found", "user not found");
    return { revoked: await service.revokeSessions(actorOf(request), userId, request.ip) };
  });

  app.post("/api/v1/users/:user_id/password-reset", admin, async (request, reply) => {
    const { user_id: userId } = request.params as { user_id: string };
    const { reset, token, link } = await service.createPasswordReset(actorOf(request), userId, request.ip);
    reply.status(201).send({
      reset: {
        id: reset.id,
        user_id: reset.userId,
        created_at: reset.createdAt.toISOString(),
        expires_at: reset.expiresAt.toISOString(),
      },
      token,
      link,
      notice: "This link is shown once and works once. Hand it to the user over a channel you trust.",
    });
  });

  app.post("/api/v1/invitations", admin, async (request, reply) => {
    const b = bodyOf(request);
    const email = typeof b.email === "string" ? b.email.trim() : "";
    if (email.length > MAX_EMAIL_CHARS || !EMAIL_PATTERN.test(email))
      throw new ApiError(400, "invalid_request", "a valid email is required");
    const role = instanceRole(b.instance_role, "member");
    const { invitation, token, link } = await service.invite(actorOf(request), email, role, request.ip);
    reply.status(201).send({
      invitation: publicInvitation(invitation),
      token,
      link,
      notice: "This link is shown once and works once. Hand it to the person over a channel you trust.",
    });
  });

  app.get("/api/v1/invitations", admin, async (request) => ({
    invitations: (await service.listInvitations(actorOf(request))).map(publicInvitation),
  }));

  app.delete("/api/v1/invitations/:invitation_id", admin, async (request, reply) => {
    const { invitation_id: id } = request.params as { invitation_id: string };
    await service.revokeInvitation(actorOf(request), id, request.ip);
    reply.status(204).send();
  });

  app.get("/api/v1/audit-log", admin, async (request) => {
    const q = request.query as Record<string, unknown>;
    const actor = q.actor === undefined ? undefined : String(q.actor);
    if (actor !== undefined && !UUID_PATTERN.test(actor))
      throw new ApiError(400, "invalid_request", "actor must be a user id");
    if (q.action !== undefined && !isAuditAction(q.action))
      throw new ApiError(400, "invalid_request", "action is not a known audit action");
    const from = parseTime(q.from, "from");
    const to = parseTime(q.to, "to");
    if (from && to && from >= to) throw new ApiError(400, "invalid_request", "from must be before to");
    const limit = parseLimit(q.limit, DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
    const cursor = parseCursor(q.cursor);
    if (cursor !== undefined && !/^[1-9][0-9]{0,17}$/.test(cursor))
      throw new ApiError(400, "invalid_request", "cursor is not valid");
    const { entries, nextCursor } = await service.auditPage(
      actorOf(request),
      {
        ...(actor !== undefined && { actorUserId: actor }),
        ...(isAuditAction(q.action) && { action: q.action }),
        ...(from && { from }),
        ...(to && { to }),
        ...(cursor !== undefined && { beforeId: cursor }),
      },
      limit,
    );
    return {
      entries: entries.map(publicAudit),
      ...(nextCursor !== undefined && { next_cursor: nextCursor }),
    };
  });
}
