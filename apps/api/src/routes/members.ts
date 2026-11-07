// The no-escalation and last-admin rules (docs/access-model.md, "Membership
// rules") are enforced by the storage layer in the same transaction as the
// change, not here, so concurrent requests cannot both pass them.

import { normalizeRetentionDays } from "@jekimo/event-schema";
import type { MemberRecord, ProjectSettingsChange, RoleRecord } from "@jekimo/storage-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { actorOf, projectAccessOf } from "../session.js";
import type { MemberRouteOptions } from "../types/index.js";
import { publicProject } from "./projects.js";

function body(request: { body: unknown }): Record<string, unknown> {
  return (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
}

export function publicMember(m: MemberRecord) {
  return {
    user_id: m.userId,
    email: m.email,
    status: m.status,
    role: m.role,
    created_at: m.createdAt.toISOString(),
  };
}

function publicRole(r: RoleRecord) {
  return {
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    built_in: r.builtIn,
    member_count: r.memberCount,
  };
}

function roleName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 40)
    throw new ApiError(400, "invalid_request", "role must be the name of a role in this project");
  return value.trim();
}

// docs/access-model.md, "Membership rules": only an instance admin may
// remove a project's last admin, on purpose.
function force(request: FastifyRequest): boolean {
  const { force: raw } = request.query as { force?: unknown };
  if (raw === undefined || raw === "false") return false;
  if (raw !== "true") throw new ApiError(400, "invalid_request", "force must be true or false");
  if (actorOf(request).instanceRole !== "admin")
    throw new ApiError(403, "forbidden", "only instance admins can remove a project's last admin");
  return true;
}

const ERRORS = {
  user_not_found: () => new ApiError(404, "user_not_found", "no user with that email or id"),
  already_member: () => new ApiError(409, "already_member", "the user is already a member of this project"),
  unknown_role: () => new ApiError(400, "unknown_role", "no role with that name in this project"),
  escalation: () =>
    new ApiError(403, "role_escalation", "you can only assign or change roles whose permissions you hold yourself"),
  not_member: () => new ApiError(404, "member_not_found", "the user is not a member of this project"),
  last_admin: () =>
    new ApiError(
      409,
      "last_admin",
      "a project must keep at least one admin; an instance admin can override this with force=true",
    ),
} as const;

export async function memberRoutes(app: FastifyInstance, opts: MemberRouteOptions): Promise<void> {
  const projectRoute = { preHandler: [opts.session, opts.projectAccess] };

  app.patch("/api/v1/projects/:id", { ...projectRoute, config: { permission: "settings.manage" } }, async (request) => {
    const b = body(request);
    const change: ProjectSettingsChange = {};
    if (b.name !== undefined) {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (name.length < 1 || name.length > 128)
        throw new ApiError(400, "invalid_request", "name must be 1 to 128 characters");
      change.name = name;
    }
    if (b.retention_days !== undefined) {
      const days = normalizeRetentionDays(b.retention_days, opts.retentionMaxDays);
      if (days === null)
        throw new ApiError(
          400,
          "invalid_request",
          `retention_days must be a whole number from 1 to ${opts.retentionMaxDays}`,
        );
      change.retentionDays = days;
    }
    if (b.sample_rate !== undefined) {
      if (typeof b.sample_rate !== "number" || !(b.sample_rate >= 0 && b.sample_rate <= 1))
        throw new ApiError(400, "invalid_request", "sample_rate must be a number from 0 to 1");
      change.sampleRate = b.sample_rate;
    }
    if (Object.keys(change).length === 0)
      throw new ApiError(400, "invalid_request", "nothing to change: send name, retention_days, or sample_rate");
    const project = await opts.metadata.updateProject(projectAccessOf(request), change, request.ip);
    return { project: publicProject(project) };
  });

  app.get(
    "/api/v1/projects/:id/roles",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => ({
      roles: (await opts.metadata.listRoles(projectAccessOf(request))).map(publicRole),
    }),
  );

  app.get(
    "/api/v1/projects/:id/members",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => ({
      members: (await opts.metadata.listMembers(projectAccessOf(request))).map(publicMember),
    }),
  );

  app.post(
    "/api/v1/projects/:id/members",
    { ...projectRoute, config: { permission: "members.manage" } },
    async (request, reply) => {
      const b = body(request);
      const role = roleName(b.role);
      let userId: string;
      if (typeof b.user_id === "string") {
        userId = b.user_id;
      } else if (typeof b.email === "string") {
        const user = await opts.metadata.findUserByEmail(b.email.trim());
        if (!user) throw ERRORS.user_not_found();
        userId = user.id;
      } else {
        throw new ApiError(400, "invalid_request", "send the user's email or user_id");
      }
      const result = await opts.metadata.addMember(projectAccessOf(request), { userId, role, sourceIp: request.ip });
      if (!result.ok) throw ERRORS[result.reason]();
      reply.status(201).send({ member: publicMember(result.member) });
    },
  );

  app.patch(
    "/api/v1/projects/:id/members/:user_id",
    { ...projectRoute, config: { permission: "members.manage" } },
    async (request) => {
      const { user_id: userId } = request.params as { user_id: string };
      const role = roleName(body(request).role);
      const result = await opts.metadata.changeMemberRole(projectAccessOf(request), {
        userId,
        role,
        force: force(request),
        sourceIp: request.ip,
      });
      if (!result.ok) throw ERRORS[result.reason]();
      return { member: publicMember(result.member) };
    },
  );

  app.delete(
    "/api/v1/projects/:id/members/:user_id",
    { ...projectRoute, config: { permission: "members.manage" } },
    async (request, reply) => {
      const { user_id: userId } = request.params as { user_id: string };
      const result = await opts.metadata.removeMember(projectAccessOf(request), {
        userId,
        force: force(request),
        sourceIp: request.ip,
      });
      if (!result.ok) throw ERRORS[result.reason]();
      reply.status(204).send();
    },
  );
}
