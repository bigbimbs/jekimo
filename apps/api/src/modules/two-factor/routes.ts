import { validateTwoFactorPolicy } from "@jekimo/event-schema";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../../errors.js";
import { bodyOf } from "../../request.js";
import { requireInstanceAdmin, sessionOf } from "../../session.js";
import type { TwoFactorRouteOptions } from "../../types/two-factor.js";

function text(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    throw new ApiError(400, "invalid_request", `${key} is required`);
  return value;
}

export async function twoFactorRoutes(app: FastifyInstance, opts: TwoFactorRouteOptions): Promise<void> {
  const secured = { preHandler: opts.session };
  const admin = { preHandler: [opts.session, requireInstanceAdmin] };
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.get("/api/v1/auth/two-factor", secured, (request) => opts.service.status(sessionOf(request).user.id));
  app.post("/api/v1/auth/two-factor/setup", secured, (request) =>
    opts.service.begin(sessionOf(request), text(bodyOf(request), "password", 128), request.ip),
  );
  app.post("/api/v1/auth/two-factor/enable", secured, (request) =>
    opts.service.enable(sessionOf(request), text(bodyOf(request), "code", 64), request.ip),
  );
  app.post("/api/v1/auth/two-factor/disable", secured, async (request, reply) => {
    const b = bodyOf(request);
    await opts.service.manage(sessionOf(request), text(b, "password", 128), text(b, "code", 64), "disable", request.ip);
    reply.status(204).send();
  });
  app.post("/api/v1/auth/two-factor/recovery-codes", secured, (request) => {
    const b = bodyOf(request);
    return opts.service.manage(
      sessionOf(request),
      text(b, "password", 128),
      text(b, "code", 64),
      "regenerate",
      request.ip,
    );
  });
  app.get("/api/v1/admin/security", admin, () => opts.service.policy());
  app.put("/api/v1/admin/security", admin, (request) => {
    const b = bodyOf(request);
    if (!validateTwoFactorPolicy({ required: b.required }))
      throw new ApiError(400, "invalid_request", "required must be a boolean");
    return opts.service.setPolicy(
      sessionOf(request),
      b.required as boolean,
      text(b, "password", 128),
      text(b, "code", 64),
      request.ip,
    );
  });
}
