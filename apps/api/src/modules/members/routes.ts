import type { MemberRecord, RoleRecord } from "@jekimo/storage-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../../errors.js";
import { bodyOf } from "../../request.js";
import { actorOf, projectAccessOf } from "../../session.js";
import type { MemberRouteOptions, MemberTarget } from "../../types/index.js";

function publicMember(m: MemberRecord) {
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

function memberTarget(b: Record<string, unknown>): MemberTarget {
  if (typeof b.user_id === "string") return { userId: b.user_id };
  if (typeof b.email === "string") return { email: b.email.trim() };
  throw new ApiError(400, "invalid_request", "send the user's email or user_id");
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

export async function memberRoutes(app: FastifyInstance, opts: MemberRouteOptions): Promise<void> {
  const { service } = opts;
  const projectRoute = { preHandler: [opts.session, opts.projectAccess] };

  app.get(
    "/api/v1/projects/:id/roles",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => ({
      roles: (await service.listRoles(projectAccessOf(request))).map(publicRole),
    }),
  );

  app.get(
    "/api/v1/projects/:id/members",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => ({
      members: (await service.listMembers(projectAccessOf(request))).map(publicMember),
    }),
  );

  app.post(
    "/api/v1/projects/:id/members",
    { ...projectRoute, config: { permission: "members.manage" } },
    async (request, reply) => {
      const b = bodyOf(request);
      const role = roleName(b.role);
      const member = await service.add(projectAccessOf(request), memberTarget(b), role, request.ip);
      reply.status(201).send({ member: publicMember(member) });
    },
  );

  app.patch(
    "/api/v1/projects/:id/members/:user_id",
    { ...projectRoute, config: { permission: "members.manage" } },
    async (request) => {
      const { user_id: userId } = request.params as { user_id: string };
      const role = roleName(bodyOf(request).role);
      const member = await service.changeRole(projectAccessOf(request), userId, role, force(request), request.ip);
      return { member: publicMember(member) };
    },
  );

  app.delete(
    "/api/v1/projects/:id/members/:user_id",
    { ...projectRoute, config: { permission: "members.manage" } },
    async (request, reply) => {
      const { user_id: userId } = request.params as { user_id: string };
      await service.remove(projectAccessOf(request), userId, force(request), request.ip);
      reply.status(204).send();
    },
  );
}
