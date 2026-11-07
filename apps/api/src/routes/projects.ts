/**
 * Projects, ingestion keys, and the event query API. Every /projects/:id
 * route declares the permission it needs in its config; requireProjectPermission
 * enforces it (docs/access-model.md, "Authorization enforcement", rule 3).
 */

import { randomInt } from "node:crypto";
import {
  EVENT_KINDS,
  type EventKind,
  LIMITS,
  normalizeRetentionDays,
  SEVERITIES,
  type Severity,
  TIMESTAMP_PATTERN,
  ULID_PATTERN,
} from "@jekimo/event-schema";
import {
  type EventPage,
  type EventQuery,
  type EventStore,
  type MetadataRepository,
  type ProjectRecord,
  type StoredEvent,
  searchWords,
} from "@jekimo/storage-postgres";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { ApiError } from "../errors.js";
import { generateIngestionKey } from "../keys.js";
import { actorOf, projectAccessOf } from "../session.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
const MAX_SEARCH_CHARS = 256;
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

/** A comma-separated list of allowed values, or undefined when absent. */
function parseList<T extends string>(value: unknown, name: string, allowed: readonly T[]): T[] | undefined {
  if (value === undefined) return undefined;
  const list = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0 || list.some((s) => !(allowed as readonly string[]).includes(s))) {
    throw new ApiError(400, "invalid_request", `${name} must be a comma-separated list of ${allowed.join(", ")}`);
  }
  return list as T[];
}

/** One exact-match value no longer than the envelope allows for that field. */
function parseExact(value: unknown, name: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > maxChars) {
    throw new ApiError(400, "invalid_request", `${name} must be 1 to ${maxChars} characters`);
  }
  return value;
}

function publicEvent(e: StoredEvent) {
  return {
    received_at: e.receivedAt.toISOString(),
    key_id: e.keyId,
    ...(e.skewMs !== undefined && { skew_ms: e.skewMs }),
    event: e.event,
  };
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
      const severities = parseList<Severity>(q.severity, "severity", SEVERITIES);
      const kinds = parseList<EventKind>(q.kind, "kind", EVENT_KINDS);
      const environment = parseExact(q.environment, "environment", LIMITS.MAX_SHORT_STRING_CHARS);
      const release = parseExact(q.release, "release", LIMITS.MAX_SHORT_STRING_CHARS);
      const fingerprint = parseExact(q.fingerprint, "fingerprint", LIMITS.MAX_FINGERPRINT_CHARS);
      const text = parseExact(q.q, "q", MAX_SEARCH_CHARS);
      if (text !== undefined) {
        if (!opts.events.capabilities.textSearch)
          throw new ApiError(400, "invalid_request", "text search is not available on this event store");
        if (searchWords(text).length === 0)
          throw new ApiError(400, "invalid_request", "q must contain at least one letter or digit");
      }
      const limit = q.limit === undefined ? DEFAULT_EVENT_LIMIT : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
        throw new ApiError(400, "invalid_request", `limit must be a whole number from 1 to ${MAX_EVENT_LIMIT}`);
      }
      const cursor = q.cursor === undefined ? undefined : String(q.cursor);
      const query: EventQuery = {
        from,
        to,
        limit,
        ...(severities && { severities }),
        ...(kinds && { kinds }),
        ...(environment !== undefined && { environment }),
        ...(release !== undefined && { release }),
        ...(fingerprint !== undefined && { fingerprint }),
        ...(text !== undefined && { text }),
        ...(cursor !== undefined && { cursor }),
      };
      let page: EventPage;
      try {
        page = await opts.events.queryEvents(projectAccessOf(request).projectId, query);
      } catch (err) {
        if (err instanceof RangeError) throw new ApiError(400, "invalid_request", "cursor is not valid");
        throw err;
      }
      return {
        events: page.events.map(publicEvent),
        ...(page.nextCursor !== undefined && { next_cursor: page.nextCursor }),
      };
    },
  );

  app.get(
    "/api/v1/projects/:id/events/:event_id",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => {
      const { event_id: eventId } = request.params as { event_id: string };
      // The project comes from the access check, so an event_id from another
      // project is simply not found here.
      const found = ULID_PATTERN.test(eventId)
        ? await opts.events.getEvent(projectAccessOf(request).projectId, eventId)
        : null;
      if (!found) throw new ApiError(404, "not_found", "event not found");
      return publicEvent(found);
    },
  );
}
