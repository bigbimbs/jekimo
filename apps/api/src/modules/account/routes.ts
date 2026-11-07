import type { SessionSummary } from "@jekimo/storage-postgres";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE } from "../../constants/index.js";
import { ApiError } from "../../errors.js";
import { passwordProblem } from "../../passwords.js";
import { publicAccountUser } from "../../presenters.js";
import { bodyOf } from "../../request.js";
import { sessionOf } from "../../session.js";
import type { AccountRouteOptions } from "../../types/index.js";

const CLEAR_COOKIE = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

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

function newPassword(value: unknown): string {
  const problem = passwordProblem(value);
  if (problem) throw new ApiError(400, "weak_password", problem);
  return value as string;
}

export async function accountRoutes(app: FastifyInstance, opts: AccountRouteOptions): Promise<void> {
  const { service } = opts;

  app.post("/api/v1/auth/password", { preHandler: opts.session }, async (request, reply) => {
    const b = bodyOf(request);
    if (typeof b.current_password !== "string")
      throw new ApiError(400, "invalid_request", "current_password is required");
    const password = newPassword(b.new_password);
    await service.changePassword(sessionOf(request), b.current_password, password, request.ip);
    reply.status(204).send();
  });

  app.get("/api/v1/auth/sessions", { preHandler: opts.session }, async (request) => {
    const s = sessionOf(request);
    const sessions = await service.listSessions(s.user.id);
    return { sessions: sessions.map((x) => publicSession(x, s.sessionId)) };
  });

  app.delete("/api/v1/auth/sessions/:session_id", { preHandler: opts.session }, async (request, reply) => {
    const s = sessionOf(request);
    const { session_id: sessionId } = request.params as { session_id: string };
    await service.revokeOwnSession(s.user.id, sessionId, request.ip);
    if (sessionId === s.sessionId) reply.clearCookie(SESSION_COOKIE, CLEAR_COOKIE);
    reply.status(204).send();
  });

  app.post("/api/v1/invitations/accept", async (request, reply) => {
    const b = bodyOf(request);
    const token = service.readToken(b.token);
    const password = newPassword(b.password);
    const user = await service.acceptInvitation(token, password, request.ip);
    request.log.info({ user_id: user.id }, "invitation accepted");
    reply.status(201).send({ user: publicAccountUser(user) });
  });

  app.post("/api/v1/auth/password-reset", async (request) => {
    const b = bodyOf(request);
    const token = service.readToken(b.token);
    const password = newPassword(b.password);
    const user = await service.resetPassword(token, password, request.ip);
    request.log.info({ user_id: user.id }, "password reset");
    return { user: publicAccountUser(user) };
  });
}
