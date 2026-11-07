/**
 * Setup, sign-in, and sign-out (docs/access-model.md, "Setup flow",
 * "Passwords", "Sessions"). Setup creates the first instance admin and the
 * first project with its ingestion key; once it completes, the setup routes
 * answer 404 like any unknown route.
 */

import { timingSafeEqual } from "node:crypto";
import type { MetadataRepository, UserRecord } from "@jekimo/storage-postgres";
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from "fastify";
import { ApiError } from "../errors.js";
import { generateIngestionKey } from "../keys.js";
import { type PasswordHasher, passwordProblem, TimingSafeVerifier } from "../passwords.js";
import { hashSessionToken, newCsrfToken, newSessionToken, SESSION_COOKIE, sessionOf } from "../session.js";
import { newProjectId, publicProject } from "./projects.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_ATTEMPTS = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Holds the one-time setup token printed to the console. Cleared once setup succeeds. */
export class SetupGate {
  constructor(private token: string | null) {}

  get open(): boolean {
    return this.token !== null;
  }

  check(presented: unknown): boolean {
    if (this.token === null || typeof presented !== "string") return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  close(): void {
    this.token = null;
  }
}

export interface AuthRouteOptions {
  metadata: MetadataRepository;
  hasher: PasswordHasher;
  setup: SetupGate;
  sessionMaxDays: number;
  /** Retention of the project created during setup. */
  retentionDefaultDays: number;
  clock: () => Date;
  session: preHandlerHookHandler;
}

function publicUser(u: UserRecord) {
  return { id: u.id, email: u.email, instance_role: u.instanceRole, created_at: u.createdAt.toISOString() };
}

function readCredentials(body: unknown): { email: string; password: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const email = typeof b.email === "string" ? b.email.trim() : "";
  if (email.length > 254 || !EMAIL.test(email)) throw new ApiError(400, "invalid_request", "a valid email is required");
  if (typeof b.password !== "string") throw new ApiError(400, "invalid_request", "password is required");
  return { email, password: b.password };
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOptions): Promise<void> {
  const verifier = new TimingSafeVerifier(opts.hasher);

  const setupGone = () => new ApiError(404, "not_found", "not found");

  // True while this instance has no users. Closes the gate for good once
  // a user exists, including one created through another API process.
  const setupOpen = async (): Promise<boolean> => {
    if (!opts.setup.open) return false;
    if ((await opts.metadata.countUsers()) === 0) return true;
    opts.setup.close();
    return false;
  };

  app.get("/api/v1/setup", async () => {
    if (!(await setupOpen())) throw setupGone();
    return { setup_required: true };
  });

  app.post("/api/v1/setup", async (request, reply) => {
    if (!(await setupOpen())) throw setupGone();
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!opts.setup.check(body.setup_token)) throw new ApiError(401, "unauthorized", "setup token is missing or wrong");
    const { email, password } = readCredentials(body);
    const problem = passwordProblem(password);
    if (problem) throw new ApiError(400, "weak_password", problem);
    const projectName = typeof body.project_name === "string" ? body.project_name.trim() : "";
    if (projectName.length < 1 || projectName.length > 128)
      throw new ApiError(400, "invalid_request", "project_name must be 1 to 128 characters");

    const user = await opts.metadata.createFirstAdmin({ email, passwordHash: await opts.hasher.hash(password) });
    opts.setup.close();
    if (!user) throw setupGone();
    request.log.info({ user_id: user.id }, "first instance admin created");

    const actor = { userId: user.id, instanceRole: user.instanceRole };
    const project = await opts.metadata.createProject(actor, {
      id: newProjectId(),
      name: projectName,
      retentionDays: opts.retentionDefaultDays,
      sourceIp: request.ip,
    });
    const access = await opts.metadata.resolveProjectAccess(actor, project.id);
    if (!access) throw new Error("project created during setup is not accessible");
    const generated = generateIngestionKey();
    const key = await opts.metadata.createIngestionKey(access, {
      keyId: generated.keyId,
      keyHash: generated.keyHash,
      name: "setup",
      sourceIp: request.ip,
    });
    // key_id is safe to log; the key itself is returned once and never logged.
    request.log.info({ project_id: project.id, key_id: key.keyId }, "first project and ingestion key created");
    reply.status(201).send({
      user: publicUser(user),
      project: publicProject(project),
      ingestion_key: {
        key_id: key.keyId,
        key: generated.key,
        name: key.name,
        created_at: key.createdAt.toISOString(),
      },
      notice: "The ingestion key is shown once. Store it in your secret manager now.",
    });
  });

  app.post("/api/v1/auth/login", async (request, reply: FastifyReply) => {
    const { email, password } = readCredentials(request.body);
    const now = opts.clock();
    const found = await opts.metadata.findUserForLogin(email);
    const valid = await verifier.verify(found?.passwordHash ?? null, password);
    const fail = new ApiError(401, "invalid_credentials", "email or password is incorrect");
    if (!found) throw fail;
    const user = found.user;
    const audit = { actorUserId: user.id, targetType: "user", targetId: user.id, sourceIp: request.ip };
    // Lockout answers exactly like a wrong password.
    const recentFailures = await opts.metadata.countFailedLogins(user.id, new Date(now.getTime() - LOCKOUT_WINDOW_MS));
    if (recentFailures >= LOCKOUT_ATTEMPTS) {
      await opts.metadata.appendAudit({ ...audit, action: "auth.login_locked" });
      throw fail;
    }
    if (!valid || user.status !== "active") {
      await opts.metadata.appendAudit({ ...audit, action: "auth.login_failed" });
      throw fail;
    }
    const token = newSessionToken();
    const csrfToken = newCsrfToken();
    const ua = request.headers["user-agent"];
    await opts.metadata.createSession({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      csrfToken,
      expiresAt: new Date(now.getTime() + opts.sessionMaxDays * DAY_MS),
      sourceIp: request.ip,
      ...(ua !== undefined && { userAgent: ua }),
    });
    await opts.metadata.appendAudit({ ...audit, action: "auth.login" });
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
    const s = sessionOf(request);
    await opts.metadata.revokeSession(s.sessionId, opts.clock());
    await opts.metadata.appendAudit({
      actorUserId: s.user.id,
      action: "auth.logout",
      targetType: "user",
      targetId: s.user.id,
      sourceIp: request.ip,
    });
    reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    reply.status(204).send();
  });
}
