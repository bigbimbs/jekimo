import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import type { IngestLimits } from "@jekimo/storage-postgres";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { DEFAULT_API_CONFIG } from "./constants/index.js";
import { apiErrorHandler } from "./errors.js";
import { accountRoutes } from "./modules/account/routes.js";
import { AccountService } from "./modules/account/service.js";
import { authRoutes } from "./modules/auth/routes.js";
import { AuthService, SetupGate } from "./modules/auth/service.js";
import { eventRoutes } from "./modules/events/routes.js";
import { EventService } from "./modules/events/service.js";
import { ingestRoutes } from "./modules/ingest/routes.js";
import { IngestService } from "./modules/ingest/service.js";
import { issueRoutes } from "./modules/issues/routes.js";
import { IssueService } from "./modules/issues/service.js";
import { keyRoutes } from "./modules/keys/routes.js";
import { KeyService } from "./modules/keys/service.js";
import { limitRoutes } from "./modules/limits/routes.js";
import { LimitService } from "./modules/limits/service.js";
import { memberRoutes } from "./modules/members/routes.js";
import { MemberService } from "./modules/members/service.js";
import { projectRoutes } from "./modules/projects/routes.js";
import { ProjectService } from "./modules/projects/service.js";
import { userRoutes } from "./modules/users/routes.js";
import { UserService } from "./modules/users/service.js";
import { argon2Hasher } from "./passwords.js";
import { rejectAuthorizationHeader, requireProjectPermission, requireSession } from "./session.js";
import type { ApiConfig, AppDeps } from "./types/index.js";

const READY_TIMEOUT_MS = 2000;

/**
 * Logger options that keep credentials and payloads out of logs. Fastify's
 * request serializer does not include headers or bodies; the redaction is a
 * second line of defense.
 */
export function loggerOptions(level: string): FastifyServerOptions["logger"] {
  return {
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "req.body",
        "body",
        "password",
        "key",
        "token",
      ],
      censor: "[REDACTED]",
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Tests run this against in-memory storage with `app.inject`; production against PostgreSQL. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const config: ApiConfig = { ...DEFAULT_API_CONFIG, ...deps.config };
  const clock = deps.clock ?? (() => new Date());
  const { metadata, events } = deps;
  const limitDefaults: IngestLimits = {
    ratePerMinute: config.rateLimitPerMinute,
    eventsPerDay: config.quotaEventsPerDay,
  };
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
  });

  const onRoute = deps.onRoute;
  if (onRoute) app.addHook("onRoute", (route) => onRoute({ method: route.method, url: route.url }));

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-jekimo-request-id", request.id);
  });
  app.setErrorHandler(apiErrorHandler);
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: "not_found", message: "not found" } });
  });

  // Health checks poll every few seconds; keep them out of info-level logs.
  // Liveness touches no dependency.
  app.get("/healthz", { logLevel: "warn" }, async () => ({ status: "ok" }));

  const readiness = deps.readiness ?? { database: () => metadata.countUsers() };
  app.get("/readyz", { logLevel: "warn" }, async (request, reply) => {
    const checks: Record<string, "ok" | "unavailable"> = {};
    await Promise.all(
      Object.entries(readiness).map(async ([name, check]) => {
        try {
          await withTimeout(check(), READY_TIMEOUT_MS);
          checks[name] = "ok";
        } catch (err) {
          checks[name] = "unavailable";
          // The error type and code only: driver messages can carry hostnames.
          const e = err as { name?: unknown; code?: unknown };
          request.log.warn({ check: name, err: { type: e?.name, code: e?.code } }, "readiness check failed");
        }
      }),
    );
    const failed = Object.keys(checks).filter((name) => checks[name] !== "ok");
    if (failed.length === 0) return { status: "ok", checks };
    reply.status(503);
    return {
      status: "unavailable",
      checks,
      error: { code: "not_ready", message: `not reachable: ${failed.sort().join(", ")}` },
    };
  });

  // Ingest stays outside the dashboard scope: no cookie parsing, no session
  // middleware, its own body parser and error format.
  await app.register(ingestRoutes, {
    service: new IngestService({
      metadata,
      queue: deps.queue,
      clock,
      limitDefaults,
      ...(deps.limits && { limits: deps.limits }),
      ...(deps.disk && { disk: deps.disk }),
    }),
  });

  await app.register(async (dashboard) => {
    dashboard.addHook("onRequest", rejectAuthorizationHeader);
    await dashboard.register(cookie);
    const session = requireSession({ metadata, idleDays: config.sessionIdleDays, clock });
    const projectAccess = requireProjectPermission(metadata);
    const hasher = deps.hasher ?? argon2Hasher;

    await dashboard.register(authRoutes, {
      service: new AuthService({
        metadata,
        hasher,
        setup: new SetupGate(deps.setupToken ?? null),
        sessionMaxDays: config.sessionMaxDays,
        retentionDefaultDays: config.retentionDefaultDays,
        clock,
      }),
      session,
      sessionMaxDays: config.sessionMaxDays,
    });
    await dashboard.register(accountRoutes, { service: new AccountService({ metadata, hasher, clock }), session });
    await dashboard.register(userRoutes, {
      service: new UserService({
        metadata,
        inviteExpiryDays: config.inviteExpiryDays,
        publicUrl: config.publicUrl,
        clock,
      }),
      session,
    });
    await dashboard.register(projectRoutes, {
      service: new ProjectService({
        metadata,
        membersCanCreateProjects: config.membersCanCreateProjects,
        retentionDefaultDays: config.retentionDefaultDays,
        retentionMaxDays: config.retentionMaxDays,
      }),
      session,
      projectAccess,
    });
    await dashboard.register(eventRoutes, { service: new EventService({ events, clock }), session, projectAccess });
    await dashboard.register(memberRoutes, { service: new MemberService({ metadata }), session, projectAccess });
    await dashboard.register(keyRoutes, {
      service: new KeyService({ metadata, clock }),
      session,
      projectAccess,
      rotationGraceHours: config.keyRotationGraceHours,
    });
    await dashboard.register(issueRoutes, { service: new IssueService({ metadata, events }), session, projectAccess });
    if (deps.limits) {
      await dashboard.register(limitRoutes, {
        service: new LimitService({ limits: deps.limits, defaults: limitDefaults }),
        session,
        projectAccess,
      });
    }
  });

  return app;
}
