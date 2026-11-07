// Every /projects/:id route declares the permission it needs in its config;
// requireProjectPermission enforces it (docs/access-model.md, "Authorization
// enforcement", rule 3).

import type { ProjectSettingsChange } from "@jekimo/storage-postgres";
import type { FastifyInstance } from "fastify";
import { MAX_PROJECT_NAME_CHARS } from "../../constants/index.js";
import { ApiError } from "../../errors.js";
import { publicProject } from "../../presenters.js";
import { bodyOf, parseName } from "../../request.js";
import { actorOf, projectAccessOf } from "../../session.js";
import type { ProjectRouteOptions } from "../../types/index.js";

export async function projectRoutes(app: FastifyInstance, opts: ProjectRouteOptions): Promise<void> {
  const { service } = opts;
  const projectRoute = { preHandler: [opts.session, opts.projectAccess] };

  app.get("/api/v1/projects", { preHandler: opts.session }, async (request) => ({
    projects: (await service.list(actorOf(request))).map(publicProject),
  }));

  app.post("/api/v1/projects", { preHandler: opts.session }, async (request, reply) => {
    const actor = actorOf(request);
    if (!service.canCreate(actor)) throw new ApiError(403, "forbidden", "only instance admins can create projects");
    const body = bodyOf(request);
    const name = parseName(body.name, "name", MAX_PROJECT_NAME_CHARS);
    const project = await service.create(actor, { name, retentionDays: body.retention_days, sourceIp: request.ip });
    request.log.info({ project_id: project.id }, "project created");
    reply.status(201).send({ project: publicProject(project) });
  });

  app.get("/api/v1/projects/:id", { ...projectRoute, config: { permission: "project.read" } }, async (request) => ({
    project: publicProject(await service.get(projectAccessOf(request))),
  }));

  app.patch("/api/v1/projects/:id", { ...projectRoute, config: { permission: "settings.manage" } }, async (request) => {
    const b = bodyOf(request);
    const change: ProjectSettingsChange = {};
    if (b.name !== undefined) change.name = parseName(b.name, "name", MAX_PROJECT_NAME_CHARS);
    if (b.retention_days !== undefined) change.retentionDays = service.retentionDays(b.retention_days);
    if (b.sample_rate !== undefined) {
      if (typeof b.sample_rate !== "number" || !(b.sample_rate >= 0 && b.sample_rate <= 1))
        throw new ApiError(400, "invalid_request", "sample_rate must be a number from 0 to 1");
      change.sampleRate = b.sample_rate;
    }
    if (Object.keys(change).length === 0)
      throw new ApiError(400, "invalid_request", "nothing to change: send name, retention_days, or sample_rate");
    const project = await service.update(projectAccessOf(request), change, request.ip);
    return { project: publicProject(project) };
  });
}
