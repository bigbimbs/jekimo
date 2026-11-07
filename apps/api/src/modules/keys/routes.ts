import { type IngestionKeySummary, ingestionKeyStatus } from "@jekimo/storage-postgres";
import type { FastifyInstance } from "fastify";
import { MAX_GRACE_HOURS } from "../../constants/index.js";
import { ApiError } from "../../errors.js";
import { bodyOf } from "../../request.js";
import { projectAccessOf } from "../../session.js";
import type { KeyRouteOptions } from "../../types/index.js";

function publicKey(k: IngestionKeySummary, now: Date) {
  return {
    key_id: k.keyId,
    name: k.name,
    status: ingestionKeyStatus(k, now),
    created_at: k.createdAt.toISOString(),
    created_by: k.createdBy,
    expires_at: k.expiresAt?.toISOString() ?? null,
    revoked_at: k.revokedAt?.toISOString() ?? null,
  };
}

export async function keyRoutes(app: FastifyInstance, opts: KeyRouteOptions): Promise<void> {
  const { service } = opts;
  const projectRoute = { preHandler: [opts.session, opts.projectAccess] };

  app.get("/api/v1/projects/:id/keys", { ...projectRoute, config: { permission: "keys.manage" } }, async (request) => {
    const { keys, now } = await service.list(projectAccessOf(request));
    return { keys: keys.map((k) => publicKey(k, now)) };
  });

  app.post(
    "/api/v1/projects/:id/keys",
    { ...projectRoute, config: { permission: "keys.manage" } },
    async (request, reply) => {
      const body = bodyOf(request);
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 128) : "";
      const { record, secret } = await service.create(projectAccessOf(request), name, request.ip);
      // key_id is safe to log; the key itself is returned once and never logged.
      request.log.info({ project_id: record.projectId, key_id: record.keyId }, "ingestion key created");
      reply.status(201).send({
        key_id: record.keyId,
        key: secret,
        name: record.name,
        created_at: record.createdAt.toISOString(),
        notice: "This key is shown once. Store it in your secret manager now.",
      });
    },
  );

  app.post(
    "/api/v1/projects/:id/keys/:key_id/rotate",
    { ...projectRoute, config: { permission: "keys.manage" } },
    async (request, reply) => {
      const { key_id: keyId } = request.params as { key_id: string };
      const b = bodyOf(request);
      const graceHours = b.grace_hours === undefined ? opts.rotationGraceHours : b.grace_hours;
      if (
        typeof graceHours !== "number" ||
        !Number.isInteger(graceHours) ||
        graceHours < 0 ||
        graceHours > MAX_GRACE_HOURS
      )
        throw new ApiError(400, "invalid_request", `grace_hours must be a whole number from 0 to ${MAX_GRACE_HOURS}`);
      const access = projectAccessOf(request);
      const { created, old, secret, now } = await service.rotate(access, keyId, graceHours, request.ip);
      request.log.info(
        { project_id: access.projectId, key_id: keyId, new_key_id: created.keyId },
        "ingestion key rotated",
      );
      reply.status(201).send({
        key_id: created.keyId,
        key: secret,
        name: created.name,
        created_at: created.createdAt.toISOString(),
        rotated: publicKey(old, now),
        notice:
          "This key is shown once. Store it in your secret manager now. The old key stops working at rotated.expires_at.",
      });
    },
  );

  app.post(
    "/api/v1/projects/:id/keys/:key_id/revoke",
    { ...projectRoute, config: { permission: "keys.manage" } },
    async (request) => {
      const { key_id: keyId } = request.params as { key_id: string };
      const access = projectAccessOf(request);
      const { key, now } = await service.revoke(access, keyId, request.ip);
      request.log.info({ project_id: access.projectId, key_id: keyId }, "ingestion key revoked");
      return { key: publicKey(key, now) };
    },
  );
}
