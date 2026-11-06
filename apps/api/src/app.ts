/**
 * Builds the API server from its dependencies, so tests can run it against
 * in-memory storage with `app.inject` and production runs it against
 * PostgreSQL.
 */

import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import type { EventStore, IngestJob, MetadataRepository, Queue } from "@jekimo/storage-postgres";
import { DEFAULT_API_CONFIG, type ApiConfig } from "./config.js";
import { apiErrorHandler } from "./errors.js";
import { argon2Hasher, type PasswordHasher } from "./passwords.js";
import { authRoutes, SetupGate } from "./routes/auth.js";
import { ingestRoutes } from "./routes/ingest.js";
import { projectRoutes } from "./routes/projects.js";
import { requireProjectPermission, requireSession } from "./session.js";

export interface AppDeps {
  metadata: MetadataRepository;
  events: EventStore;
  queue: Queue<IngestJob>;
  config?: Partial<ApiConfig>;
  /** The one-time setup token, or null when setup is closed. */
  setupToken?: string | null;
  hasher?: PasswordHasher;
  clock?: () => Date;
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
      paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]', "req.body", "body", "password", "key", "token"],
      censor: "[REDACTED]",
    },
  };
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

  app.get("/healthz", async (_request, reply) => {
    try {
      await deps.metadata.countUsers();
      return { status: "ok" };
    } catch {
      reply.status(503);
      return { status: "unavailable" };
    }
  });

  // Ingest is registered in its own scope: no cookie parsing, no session
  // middleware, its own body parser and error format.
  await app.register(ingestRoutes, { metadata: deps.metadata, queue: deps.queue, clock });

  await app.register(async (dashboard) => {
    await dashboard.register(cookie);
    const session = requireSession({ metadata: deps.metadata, idleDays: config.sessionIdleDays, clock });
    await dashboard.register(authRoutes, {
      metadata: deps.metadata,
      hasher: deps.hasher ?? argon2Hasher,
      setup: new SetupGate(deps.setupToken ?? null),
      sessionMaxDays: config.sessionMaxDays,
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
  });

  return app;
}
