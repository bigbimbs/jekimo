/**
 * The signed-in user's own account (docs/access-model.md, "Sessions"):
 * password change and session listing and revocation. Also the two routes
 * that redeem single-use links without a session: accepting an invitation
 * and resetting a password.
 */

import type { MetadataRepository, SessionSummary, UserRecord } from "@jekimo/storage-postgres";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { hashAccountToken, readAccountToken } from "../account-links.js";
import { ApiError } from "../errors.js";
import { type PasswordHasher, passwordProblem } from "../passwords.js";
import { SESSION_COOKIE, sessionOf } from "../session.js";

export interface AccountRouteOptions {
  metadata: MetadataRepository;
  hasher: PasswordHasher;
  clock: () => Date;
  session: preHandlerHookHandler;
}

export function publicAccountUser(u: UserRecord) {
  return {
    id: u.id,
    email: u.email,
    instance_role: u.instanceRole,
    status: u.status,
    created_at: u.createdAt.toISOString(),
  };
}

function publicSession(s: SessionSummary, currentId: string) {
  return {
    id: s.sessionId,
    created_at: s.createdAt.toISOString(),
    last_seen_at: s.lastSeenAt.toISOString(),
    expires_at: s.expiresAt.toISOString(),
    source_ip: s.sourceIp,
    user_agent: s.userAgent,
    current: s.sessionId === currentId,
  };
}

function body(request: { body: unknown }): Record<string, unknown> {
  return (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
}

function newPassword(value: unknown): string {
  const problem = passwordProblem(value);
  if (problem) throw new ApiError(400, "weak_password", problem);
  return value as string;
}

const CLEAR_COOKIE = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;
const invalidToken = () =>
  new ApiError(400, "invalid_token", "this link is not valid, has expired, or was already used");

export async function accountRoutes(app: FastifyInstance, opts: AccountRouteOptions): Promise<void> {
  app.post("/api/v1/auth/password", { preHandler: opts.session }, async (request, reply) => {
    const s = sessionOf(request);
    const b = body(request);
    if (typeof b.current_password !== "string")
      throw new ApiError(400, "invalid_request", "current_password is required");
    const password = newPassword(b.new_password);
    const found = await opts.metadata.findUserForLogin(s.user.email);
    if (!found || !(await opts.hasher.verify(found.passwordHash, b.current_password))) {
      throw new ApiError(403, "invalid_credentials", "the current password is incorrect");
    }
    await opts.metadata.changePassword(s.user.id, await opts.hasher.hash(password), {
      now: opts.clock(),
      keepSessionId: s.sessionId,
      sourceIp: request.ip,
    });
    reply.status(204).send();
  });

  app.get("/api/v1/auth/sessions", { preHandler: opts.session }, async (request) => {
    const s = sessionOf(request);
    const sessions = await opts.metadata.listSessions(s.user.id, opts.clock());
    return { sessions: sessions.map((x) => publicSession(x, s.sessionId)) };
  });

  app.delete("/api/v1/auth/sessions/:session_id", { preHandler: opts.session }, async (request, reply) => {
    const s = sessionOf(request);
    const { session_id: sessionId } = request.params as { session_id: string };
    const revoked = await opts.metadata.revokeOwnSession(s.user.id, sessionId, {
      now: opts.clock(),
      sourceIp: request.ip,
    });
    if (!revoked) throw new ApiError(404, "not_found", "session not found");
    if (sessionId === s.sessionId) reply.clearCookie(SESSION_COOKIE, CLEAR_COOKIE);
    reply.status(204).send();
  });

  app.post("/api/v1/invitations/accept", async (request, reply) => {
    const b = body(request);
    const token = readAccountToken(b.token);
    if (token === null) throw invalidToken();
    const password = newPassword(b.password);
    const result = await opts.metadata.acceptInvitation(hashAccountToken(token), await opts.hasher.hash(password), {
      now: opts.clock(),
      sourceIp: request.ip,
    });
    if (!result.ok) {
      if (result.reason === "email_taken")
        throw new ApiError(409, "email_taken", "an account with this email already exists");
      throw invalidToken();
    }
    request.log.info({ user_id: result.user.id }, "invitation accepted");
    reply.status(201).send({ user: publicAccountUser(result.user) });
  });

  app.post("/api/v1/auth/password-reset", async (request) => {
    const b = body(request);
    const token = readAccountToken(b.token);
    if (token === null) throw invalidToken();
    const password = newPassword(b.password);
    const result = await opts.metadata.resetPassword(hashAccountToken(token), await opts.hasher.hash(password), {
      now: opts.clock(),
      sourceIp: request.ip,
    });
    if (!result.ok) throw invalidToken();
    request.log.info({ user_id: result.user.id }, "password reset");
    return { user: publicAccountUser(result.user) };
  });
}
