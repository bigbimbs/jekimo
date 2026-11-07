import type { FastifyInstance } from "fastify";
import { EMAIL_PATTERN, MAX_EMAIL_CHARS, MAX_PROJECT_NAME_CHARS, SESSION_COOKIE } from "../../constants/index.js";
import { ApiError } from "../../errors.js";
import { passwordProblem } from "../../passwords.js";
import { publicProject, publicUser } from "../../presenters.js";
import { bodyOf, parseName } from "../../request.js";
import { sessionOf } from "../../session.js";
import type { AuthRouteOptions } from "../../types/index.js";

function readCredentials(b: Record<string, unknown>): { email: string; password: string } {
  const email = typeof b.email === "string" ? b.email.trim() : "";
  if (email.length > MAX_EMAIL_CHARS || !EMAIL_PATTERN.test(email))
    throw new ApiError(400, "invalid_request", "a valid email is required");
  if (typeof b.password !== "string") throw new ApiError(400, "invalid_request", "password is required");
  return { email, password: b.password };
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOptions): Promise<void> {
  const { service } = opts;

  app.get("/api/v1/setup", async () => {
    await service.assertSetupOpen();
    return { setup_required: true };
  });

  app.post("/api/v1/setup", async (request, reply) => {
    await service.assertSetupOpen();
    const body = bodyOf(request);
    if (!service.setupTokenMatches(body.setup_token))
      throw new ApiError(401, "unauthorized", "setup token is missing or wrong");
    const { email, password } = readCredentials(body);
    const problem = passwordProblem(password);
    if (problem) throw new ApiError(400, "weak_password", problem);
    const projectName = parseName(body.project_name, "project_name", MAX_PROJECT_NAME_CHARS);
    const { user, project, key, secret } = await service.completeSetup(
      { email, password, projectName, sourceIp: request.ip },
      request.log,
    );
    reply.status(201).send({
      user: publicUser(user),
      project: publicProject(project),
      ingestion_key: {
        key_id: key.keyId,
        key: secret,
        name: key.name,
        created_at: key.createdAt.toISOString(),
      },
      notice: "The ingestion key is shown once. Store it in your secret manager now.",
    });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const { email, password } = readCredentials(bodyOf(request));
    const { user, token, csrfToken } = await service.login({
      email,
      password,
      sourceIp: request.ip,
      userAgent: request.headers["user-agent"],
    });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: opts.sessionMaxDays * 24 * 60 * 60,
    });
    return { user: publicUser(user), csrf_token: csrfToken };
  });

  app.get("/api/v1/auth/session", { preHandler: opts.session }, async (request) => {
    const s = sessionOf(request);
    return { user: publicUser(s.user), csrf_token: s.csrfToken, expires_at: s.expiresAt.toISOString() };
  });

  app.post("/api/v1/auth/logout", { preHandler: opts.session }, async (request, reply) => {
    await service.logout(sessionOf(request), request.ip);
    reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    reply.status(204).send();
  });
}
