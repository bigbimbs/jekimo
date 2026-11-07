/**
 * Ingestion key listing, rotation, and revocation (docs/ingestion-protocol.md,
 * "Authentication"). Keys are created in projects.ts. Responses carry
 * key_id, never a hash; the full key appears only in the rotation response,
 * once, and is never logged.
 */

import { type IngestionKeySummary, ingestionKeyStatus, type MetadataRepository } from "@jekimo/storage-postgres";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { ApiError } from "../errors.js";
import { generateIngestionKey } from "../keys.js";
import { projectAccessOf } from "../session.js";

const HOUR_MS = 60 * 60 * 1000;
const MAX_GRACE_HOURS = 720;

export interface KeyRouteOptions {
  metadata: MetadataRepository;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
  /** Default grace period for a rotated key. */
  rotationGraceHours: number;
  clock: () => Date;
}

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

const keyNotFound = () => new ApiError(404, "key_not_found", "no ingestion key with that key_id in this project");

export async function keyRoutes(app: FastifyInstance, opts: KeyRouteOptions): Promise<void> {
  const projectRoute = { preHandler: [opts.session, opts.projectAccess] };

  app.get("/api/v1/projects/:id/keys", { ...projectRoute, config: { permission: "keys.manage" } }, async (request) => {
    const now = opts.clock();
    const keys = await opts.metadata.listIngestionKeys(projectAccessOf(request));
    return { keys: keys.map((k) => publicKey(k, now)) };
  });

  app.post(
    "/api/v1/projects/:id/keys/:key_id/rotate",
    { ...projectRoute, config: { permission: "keys.manage" } },
    async (request, reply) => {
      const { key_id: keyId } = request.params as { key_id: string };
      const b = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<
        string,
        unknown
      >;
      const graceHours = b.grace_hours === undefined ? opts.rotationGraceHours : b.grace_hours;
      if (
        typeof graceHours !== "number" ||
        !Number.isInteger(graceHours) ||
        graceHours < 0 ||
        graceHours > MAX_GRACE_HOURS
      )
        throw new ApiError(400, "invalid_request", `grace_hours must be a whole number from 0 to ${MAX_GRACE_HOURS}`);
      const now = opts.clock();
      const generated = generateIngestionKey();
      const result = await opts.metadata.rotateIngestionKey(projectAccessOf(request), {
        keyId,
        newKeyId: generated.keyId,
        newKeyHash: generated.keyHash,
        oldExpiresAt: new Date(now.getTime() + graceHours * HOUR_MS),
        now,
        sourceIp: request.ip,
      });
      if (!result.ok) {
        if (result.reason === "not_active")
          throw new ApiError(
            409,
            "key_not_active",
            "only an active key can be rotated; this one is revoked or rotating",
          );
        throw keyNotFound();
      }
      // key_ids are safe to log; the new key itself is returned once and never logged.
      request.log.info(
        { project_id: projectAccessOf(request).projectId, key_id: keyId, new_key_id: result.created.keyId },
        "ingestion key rotated",
      );
      reply.status(201).send({
        key_id: result.created.keyId,
        key: generated.key,
        name: result.created.name,
        created_at: result.created.createdAt.toISOString(),
        rotated: publicKey(result.old, now),
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
      const now = opts.clock();
      const result = await opts.metadata.revokeIngestionKey(projectAccessOf(request), {
        keyId,
        now,
        sourceIp: request.ip,
      });
      if (!result.ok) {
        if (result.reason === "already_revoked")
          throw new ApiError(409, "key_already_revoked", "this key is already revoked");
        throw keyNotFound();
      }
      request.log.info({ project_id: projectAccessOf(request).projectId, key_id: keyId }, "ingestion key revoked");
      return { key: publicKey(result.key, now) };
    },
  );
}
