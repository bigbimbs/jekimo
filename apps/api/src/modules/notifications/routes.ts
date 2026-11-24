import type { FastifyInstance } from "fastify";
import { bodyOf } from "../../request.js";
import { actorOf, projectAccessOf, requireInstanceAdmin } from "../../session.js";
import type { NotificationRouteOptions } from "../../types/notifications.js";

export async function notificationRoutes(app: FastifyInstance, opts: NotificationRouteOptions): Promise<void> {
  const s = opts.service;
  const admin = { preHandler: [opts.session, requireInstanceAdmin] };
  const project = {
    preHandler: [opts.session, opts.projectAccess],
    config: { permission: "settings.manage" as const },
  };
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store");
  });
  app.get("/api/v1/admin/email", admin, () => s.smtp());
  app.put("/api/v1/admin/email", admin, (req) => s.saveSmtp(actorOf(req), bodyOf(req)));
  app.post("/api/v1/admin/email/test", admin, async (req, reply) => {
    await s.testEmail(actorOf(req), bodyOf(req));
    return reply.status(202).send({ queued: true });
  });
  app.get("/api/v1/admin/email/deliveries", admin, async () => ({ deliveries: await s.deliveries(null) }));
  app.get("/api/v1/projects/:id/notification-channels", project, async (req) => ({
    channels: await s.channels(projectAccessOf(req)),
  }));
  app.post("/api/v1/projects/:id/notification-channels", project, async (req, reply) =>
    reply.status(201).send({ channel: await s.createChannel(projectAccessOf(req), bodyOf(req)) }),
  );
  app.patch("/api/v1/projects/:id/notification-channels/:channel", project, async (req) => {
    await s.enableChannel(projectAccessOf(req), (req.params as { channel: string }).channel, bodyOf(req));
    return { updated: true };
  });
  app.post("/api/v1/projects/:id/notification-channels/:channel/test", project, async (req, reply) => {
    await s.testChannel(projectAccessOf(req), (req.params as { channel: string }).channel);
    return reply.status(202).send({ queued: true });
  });
  app.get("/api/v1/projects/:id/alert-rules", project, async (req) => ({ rules: await s.rules(projectAccessOf(req)) }));
  app.post("/api/v1/projects/:id/alert-rules", project, async (req, reply) =>
    reply.status(201).send({ rule: await s.saveRule(projectAccessOf(req), bodyOf(req)) }),
  );
  app.put("/api/v1/projects/:id/alert-rules/:rule", project, async (req) => ({
    rule: await s.saveRule(projectAccessOf(req), bodyOf(req), (req.params as { rule: string }).rule),
  }));
  app.get("/api/v1/projects/:id/notification-deliveries", project, async (req) => ({
    deliveries: await s.deliveries(projectAccessOf(req)),
  }));
}
