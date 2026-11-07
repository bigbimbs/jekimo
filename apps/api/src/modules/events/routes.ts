import { EVENT_KINDS, type EventKind, LIMITS, SEVERITIES, type Severity } from "@jekimo/event-schema";
import type { EventQuery } from "@jekimo/storage-postgres";
import type { FastifyInstance } from "fastify";
import { DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT, MAX_SEARCH_CHARS } from "../../constants/index.js";
import { publicEvent } from "../../presenters.js";
import { parseCursor, parseExact, parseLimit, parseList, parseTime } from "../../request.js";
import { projectAccessOf } from "../../session.js";
import type { EventRouteOptions } from "../../types/index.js";

export async function eventRoutes(app: FastifyInstance, opts: EventRouteOptions): Promise<void> {
  const { service } = opts;
  const projectRoute = { preHandler: [opts.session, opts.projectAccess] };

  app.get(
    "/api/v1/projects/:id/events",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => {
      const q = request.query as Record<string, unknown>;
      const to = parseTime(q.to, "to");
      const from = parseTime(q.from, "from");
      const window = service.window(from, to);
      const severities = parseList<Severity>(q.severity, "severity", SEVERITIES);
      const kinds = parseList<EventKind>(q.kind, "kind", EVENT_KINDS);
      const environment = parseExact(q.environment, "environment", LIMITS.MAX_SHORT_STRING_CHARS);
      const release = parseExact(q.release, "release", LIMITS.MAX_SHORT_STRING_CHARS);
      const fingerprint = parseExact(q.fingerprint, "fingerprint", LIMITS.MAX_FINGERPRINT_CHARS);
      const text = parseExact(q.q, "q", MAX_SEARCH_CHARS);
      if (text !== undefined) service.assertSearchable(text);
      const limit = parseLimit(q.limit, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
      const cursor = parseCursor(q.cursor);
      const query: EventQuery = {
        ...window,
        limit,
        ...(severities && { severities }),
        ...(kinds && { kinds }),
        ...(environment !== undefined && { environment }),
        ...(release !== undefined && { release }),
        ...(fingerprint !== undefined && { fingerprint }),
        ...(text !== undefined && { text }),
        ...(cursor !== undefined && { cursor }),
      };
      const page = await service.query(projectAccessOf(request), query);
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
      return publicEvent(await service.get(projectAccessOf(request), eventId));
    },
  );
}
