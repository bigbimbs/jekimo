import type { FastifyInstance, FastifyRequest } from "fastify";
import { bodyOf } from "../../request.js";
import { projectAccessOf } from "../../session.js";
import type { CronRouteOptions } from "../../types/cron.js";
import type { CronService } from "./service.js";

export async function cronRoutes(app: FastifyInstance, opts: CronRouteOptions): Promise<void> {
  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });
  const read = { preHandler: [opts.session, opts.projectAccess], config: { permission: "project.read" as const } };
  const write = { preHandler: [opts.session, opts.projectAccess], config: { permission: "settings.manage" as const } };
  app.get("/api/v1/projects/:id/cron-monitors", read, async (req) => ({
    monitors: await opts.service.list(projectAccessOf(req)),
  }));
  app.post("/api/v1/projects/:id/cron-monitors", write, async (req, reply) =>
    reply.status(201).send({ monitor: await opts.service.create(projectAccessOf(req), bodyOf(req)) }),
  );
  app.patch("/api/v1/projects/:id/cron-monitors/:monitor", write, async (req) => {
    await opts.service.setEnabled(projectAccessOf(req), (req.params as { monitor: string }).monitor, bodyOf(req));
    return { updated: true };
  });
  app.get("/api/v1/projects/:id/cron-monitors/:monitor/runs", read, async (req) => ({
    runs: await opts.service.runs(projectAccessOf(req), (req.params as { monitor: string }).monitor),
  }));
}
export async function cronCheckInRoutes(app: FastifyInstance, opts: { service: CronService }): Promise<void> {
  const projects = new WeakMap<FastifyRequest, string>();
  app.addHook("onRequest", async (req) => {
    projects.set(req, await opts.service.authenticate(req.headers.authorization));
  });
  app.post("/api/v1/cron/:monitor/check-ins", { bodyLimit: 4096 }, async (req, reply) => {
    const projectId = projects.get(req);
    if (!projectId) throw new Error("missing cron credential");
    const run = await opts.service.checkIn(projectId, (req.params as { monitor: string }).monitor, bodyOf(req));
    return reply.header("cache-control", "no-store").send({ run });
  });
}
