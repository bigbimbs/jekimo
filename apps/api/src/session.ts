/**
 * Session authentication for every endpoint except ingest
 * (docs/access-model.md, "Sessions" and "Authorization enforcement").
 *
 * Server-side sessions identified by a random 256-bit token in an HttpOnly,
 * Secure, SameSite=Lax cookie. Only the token's SHA-256 is stored.
 * Cookie-authenticated state changes need the session's CSRF token in a
 * header. Ingestion keys are never accepted here: any Authorization header
 * is rejected rather than ignored, so a misconfigured client finds out.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ProjectPermission } from "@jekimo/event-schema";
import type { Actor, MetadataRepository, ProjectAccess, SessionRecord } from "@jekimo/storage-postgres";
import { ApiError } from "./errors.js";

export const SESSION_COOKIE = "jekimo_session";
export const CSRF_HEADER = "x-jekimo-csrf-token";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Avoid a write per request: last_seen_at moves at most once a minute. */
const TOUCH_INTERVAL_MS = 60_000;

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
    session?: SessionRecord;
    projectAccess?: ProjectAccess;
  }
  interface FastifyContextConfig {
    /** The project permission a /projects/:id route requires. */
    permission?: ProjectPermission;
  }
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(token, "utf8").digest());
}

export function newCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface SessionOptions {
  metadata: MetadataRepository;
  idleDays: number;
  clock: () => Date;
}

/** preHandler that requires a live session and, for state changes, the CSRF header. */
export function requireSession(opts: SessionOptions) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (request.headers.authorization !== undefined) {
      throw new ApiError(401, "unauthorized", "this endpoint accepts session cookies only");
    }
    const token = request.cookies[SESSION_COOKIE];
    if (!token) throw new ApiError(401, "unauthorized", "sign in required");
    const now = opts.clock();
    const session = await opts.metadata.findSession(hashSessionToken(token), now);
    if (!session) throw new ApiError(401, "unauthorized", "sign in required");
    if (now.getTime() - session.lastSeenAt.getTime() >= opts.idleDays * DAY_MS) {
      await opts.metadata.revokeSession(session.sessionId, now);
      throw new ApiError(401, "unauthorized", "session expired");
    }
    if (!SAFE_METHODS.has(request.method)) {
      const csrf = request.headers[CSRF_HEADER];
      if (typeof csrf !== "string" || !safeEqual(csrf, session.csrfToken)) {
        throw new ApiError(403, "csrf_failed", `state-changing requests need the ${CSRF_HEADER} header`);
      }
    }
    if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      await opts.metadata.touchSession(session.sessionId, now);
    }
    request.session = session;
    request.actor = { userId: session.user.id, instanceRole: session.user.instanceRole };
  };
}

/**
 * preHandler for /projects/:id routes, after requireSession. Resolves the
 * project through the storage layer and checks the permission the route
 * declares in its config. A project the user cannot see is a 404, so the
 * response does not reveal whether it exists.
 */
export function requireProjectPermission(metadata: MetadataRepository) {
  return async (request: FastifyRequest): Promise<void> => {
    const permission = request.routeOptions.config.permission;
    if (!permission) throw new Error(`route ${request.routeOptions.url} declares no permission`);
    const { id } = request.params as { id: string };
    const access = await metadata.resolveProjectAccess(request.actor!, id);
    if (!access) throw new ApiError(404, "not_found", "project not found");
    if (!access.permissions.has(permission)) throw new ApiError(403, "forbidden", `this action needs the ${permission} permission`);
    request.projectAccess = access;
  };
}
