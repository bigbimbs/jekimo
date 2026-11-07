/**
 * Projects, ingestion keys, and the event query API. Every /projects/:id
 * route declares the permission it needs in its config; requireProjectPermission
 * enforces it (docs/access-model.md, "Authorization enforcement", rule 3).
 */

import { randomInt } from "node:crypto";
import { normalizeRetentionDays, SEVERITIES, type Severity, TIMESTAMP_PATTERN } from "@jekimo/event-schema";
import type { EventStore, MetadataRepository, ProjectRecord } from "@jekimo/storage-postgres";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { ApiError } from "../errors.js";
import { generateIngestionKey } from "../keys.js";
import { actorOf, projectAccessOf } from "../session.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
const PROJECT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export interface ProjectRouteOptions {
  metadata: MetadataRepository;
  events: EventStore;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
  membersCanCreateProjects: boolean;
  retentionDefaultDays: number;
  retentionMaxDays: number;
  clock: () => Date;
}

function newProjectId(): string {
  let id = "prj_";
  for (let i = 0; i < 16; i++) id += PROJECT_ID_ALPHABET[randomInt(PROJECT_ID_ALPHABET.length)];
  return id;
}

function publicProject(p: ProjectRecord) {
  return {
    id: p.id,
    name: p.name,
    retention_days: p.retentionDays,
    sample_rate: p.sampleRate,
    disabled: p.disabled,
    created_at: p.createdAt.toISOString(),
  };
}

function parseTime(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, "invalid_request", `${name} must be an RFC 3339 timestamp`);
  }
  return new Date(value);
}

export async function projectRoutes(app: FastifyInstance, opts: ProjectRouteOptions): Promise<void> {
  const projectRoute = { preHandler: [opts.session, opts.projectAccess] };

  app.get("/api/v1/projects", { preHandler: opts.session }, async (request) => ({
    projects: (await opts.metadata.listProjects(actorOf(request))).map(publicProject),
  }));

  app.post("/api/v1/projects", { preHandler: opts.session }, async (request, reply) => {
    const actor = actorOf(request);
    if (actor.instanceRole !== "admin" && !opts.membersCanCreateProjects) {
      throw new ApiError(403, "forbidden", "only instance admins can create projects");
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 128)
      throw new ApiError(400, "invalid_request", "name must be 1 to 128 characters");
    const retentionDays =
      body.retention_days === undefined
        ? opts.retentionDefaultDays
        : normalizeRetentionDays(body.retention_days, opts.retentionMaxDays);
    if (retentionDays === null) {
      throw new ApiError(
        400,
        "invalid_request",
        `retention_days must be a whole number from 1 to ${opts.retentionMaxDays}`,
      );
    }
    const project = await opts.metadata.createProject(actor, {
      id: newProjectId(),
      name,
      retentionDays,
      sourceIp: request.ip,
    });
    request.log.info({ project_id: project.id }, "project created");
    reply.status(201).send({ project: publicProject(project) });
  });

  app.get("/api/v1/projects/:id", { ...projectRoute, config: { permission: "project.read" } }, async (request) => ({
    project: publicProject(await opts.metadata.getProject(projectAccessOf(request))),
  }));

  app.post(
    "/api/v1/projects/:id/keys",
    { ...projectRoute, config: { permission: "keys.manage" } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 128) : "";
      const generated = generateIngestionKey();
      const record = await opts.metadata.createIngestionKey(projectAccessOf(request), {
        keyId: generated.keyId,
        keyHash: generated.keyHash,
        name,
        sourceIp: request.ip,
      });
      // key_id is safe to log; the key itself is returned once and never logged.
      request.log.info({ project_id: record.projectId, key_id: record.keyId }, "ingestion key created");
      reply.status(201).send({
        key_id: record.keyId,
        key: generated.key,
        name: record.name,
        created_at: record.createdAt.toISOString(),
        notice: "This key is shown once. Store it in your secret manager now.",
      });
    },
  );

  app.get(
    "/api/v1/projects/:id/events",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => {
      const q = request.query as Record<string, unknown>;
      const to = parseTime(q.to, "to") ?? opts.clock();
      const from = parseTime(q.from, "from") ?? new Date(to.getTime() - DAY_MS);
      if (from >= to) throw new ApiError(400, "invalid_request", "from must be before to");
      let severities: Severity[] | undefined;
      if (q.severity !== undefined) {
        const list = String(q.severity)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const bad = list.find((s) => !(SEVERITIES as readonly string[]).includes(s));
        if (bad !== undefined || list.length === 0)
          throw new ApiError(
            400,
            "invalid_request",
            `severity must be a comma-separated list of ${SEVERITIES.join(", ")}`,
          );
        severities = list as Severity[];
      }
      const limit = q.limit === undefined ? DEFAULT_EVENT_LIMIT : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
        throw new ApiError(400, "invalid_request", `limit must be a whole number from 1 to ${MAX_EVENT_LIMIT}`);
      }
      const cursor = q.cursor === undefined ? undefined : String(q.cursor);
      try {
        const page = await opts.events.queryEvents(projectAccessOf(request).projectId, {
          from,
          to,
          limit,
          ...(severities && { severities }),
          ...(cursor !== undefined && { cursor }),
        });
        return {
          events: page.events.map((e) => ({
            received_at: e.receivedAt.toISOString(),
            key_id: e.keyId,
            ...(e.skewMs !== undefined && { skew_ms: e.skewMs }),
            event: e.event,
          })),
          ...(page.nextCursor !== undefined && { next_cursor: page.nextCursor }),
        };
      } catch (err) {
        if (err instanceof RangeError) throw new ApiError(400, "invalid_request", "cursor is not valid");
        throw err;
      }
    },
  );
}
