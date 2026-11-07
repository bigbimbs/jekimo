/**
 * Builds the API server from its dependencies, so tests can run it against
 * in-memory storage with `app.inject` and production runs it against
 * PostgreSQL.
 */

import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import type {
  DiskMonitor,
  EventStore,
  IngestJob,
  IngestLimitStore,
  MetadataRepository,
  Queue,
} from "@jekimo/storage-postgres";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { type ApiConfig, DEFAULT_API_CONFIG } from "./config.js";
import { apiErrorHandler } from "./errors.js";
import { argon2Hasher, type PasswordHasher } from "./passwords.js";
import { authRoutes, SetupGate } from "./routes/auth.js";
import { ingestRoutes } from "./routes/ingest.js";
import { limitRoutes } from "./routes/limits.js";
import { projectRoutes } from "./routes/projects.js";
import { requireProjectPermission, requireSession } from "./session.js";

export interface AppDeps {
  metadata: MetadataRepository;
  events: EventStore;
  queue: Queue<IngestJob>;
  /** Absent only in tests: ingest is then not limited. */
  limits?: IngestLimitStore;
  /** Absent only in tests: disk space is then not checked. */
  disk?: DiskMonitor;
  config?: Partial<ApiConfig>;
  /** The one-time setup token, or null when setup is closed. */
  setupToken?: string | null;
  hasher?: PasswordHasher;
  clock?: () => Date;
  /**
   * Dependency checks for `GET /readyz`, by name. Each resolves when the
   * dependency is reachable. Defaults to a metadata read as "database".
   */
  readiness?: Record<string, () => Promise<unknown>>;
  /** Fastify logger options; false in tests. */
  logger?: FastifyServerOptions["logger"];
}

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

const READY_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const config: ApiConfig = { ...DEFAULT_API_CONFIG, ...deps.config };
  const clock = deps.clock ?? (() => new Date());
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-jekimo-request-id", request.id);
  });
  app.setErrorHandler(apiErrorHandler);
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: "not_found", message: "not found" } });
  });

  // Health checks poll every few seconds; keep them out of info-level logs.
  // Liveness: the process is up and serving. No dependency is touched.
  app.get("/healthz", { logLevel: "warn" }, async () => ({ status: "ok" }));

  // Readiness: every dependency answers within READY_TIMEOUT_MS.
  const readiness = deps.readiness ?? { database: () => deps.metadata.countUsers() };
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

  // Ingest is registered in its own scope: no cookie parsing, no session
  // middleware, its own body parser and error format.
  await app.register(ingestRoutes, {
    metadata: deps.metadata,
    queue: deps.queue,
    clock,
    limitDefaults: { ratePerMinute: config.rateLimitPerMinute, eventsPerDay: config.quotaEventsPerDay },
    ...(deps.limits && { limits: deps.limits }),
    ...(deps.disk && { disk: deps.disk }),
  });

  await app.register(async (dashboard) => {
    await dashboard.register(cookie);
    const session = requireSession({ metadata: deps.metadata, idleDays: config.sessionIdleDays, clock });
    await dashboard.register(authRoutes, {
      metadata: deps.metadata,
      hasher: deps.hasher ?? argon2Hasher,
      setup: new SetupGate(deps.setupToken ?? null),
      sessionMaxDays: config.sessionMaxDays,
      retentionDefaultDays: config.retentionDefaultDays,
      clock,
      session,
    });
    await dashboard.register(projectRoutes, {
      metadata: deps.metadata,
      events: deps.events,
      session,
      projectAccess: requireProjectPermission(deps.metadata),
      membersCanCreateProjects: config.membersCanCreateProjects,
      retentionDefaultDays: config.retentionDefaultDays,
      retentionMaxDays: config.retentionMaxDays,
      clock,
    });
    if (deps.limits) {
      await dashboard.register(limitRoutes, {
        limits: deps.limits,
        session,
        projectAccess: requireProjectPermission(deps.metadata),
        defaults: { ratePerMinute: config.rateLimitPerMinute, eventsPerDay: config.quotaEventsPerDay },
      });
    }
  });

  return app;
}
