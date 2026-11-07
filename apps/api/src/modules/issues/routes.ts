// Permissions per docs/access-model.md, "Permission catalogue".

import { EVENT_KINDS, type EventKind, LIMITS, SEVERITIES, type Severity } from "@jekimo/event-schema";
import { ISSUE_STATUSES, type IssueQuery, type IssueRecord, type IssueStatus } from "@jekimo/storage-postgres";
import type { FastifyInstance } from "fastify";
import { DEFAULT_ISSUE_LIMIT, ISSUE_ACTIONS, MAX_ISSUE_LIMIT } from "../../constants/index.js";
import { ApiError } from "../../errors.js";
import { publicEvent } from "../../presenters.js";
import { parseCursor, parseExact, parseLimit, parseList, parseTime } from "../../request.js";
import { projectAccessOf } from "../../session.js";
import type { IssueRouteOptions } from "../../types/index.js";

function publicIssue(i: IssueRecord) {
  return {
    id: i.id,
    fingerprint: i.fingerprint,
    title: i.title,
    kind: i.kind,
    status: i.status,
    last_severity: i.lastSeverity,
    event_count: i.eventCount,
    first_seen: i.firstSeen.toISOString(),
    last_seen: i.lastSeen.toISOString(),
    environments: i.environments,
    ...(i.lastEventId !== undefined && { last_event_id: i.lastEventId }),
    ...(i.statusChangedAt !== undefined && { status_changed_at: i.statusChangedAt.toISOString() }),
  };
}

export async function issueRoutes(app: FastifyInstance, opts: IssueRouteOptions): Promise<void> {
  const { service } = opts;
  const projectRoute = { preHandler: [opts.session, opts.projectAccess] };

  app.get(
    "/api/v1/projects/:id/issues",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => {
      const q = request.query as Record<string, unknown>;
      const statuses = parseList<IssueStatus>(q.status, "status", ISSUE_STATUSES);
      const kinds = parseList<EventKind>(q.kind, "kind", EVENT_KINDS);
      const severities = parseList<Severity>(q.severity, "severity", SEVERITIES);
      const environment = parseExact(q.environment, "environment", LIMITS.MAX_SHORT_STRING_CHARS);
      const from = parseTime(q.from, "from");
      const to = parseTime(q.to, "to");
      if (from && to && from >= to) throw new ApiError(400, "invalid_request", "from must be before to");
      const limit = parseLimit(q.limit, DEFAULT_ISSUE_LIMIT, MAX_ISSUE_LIMIT);
      const cursor = parseCursor(q.cursor);
      const query: IssueQuery = {
        limit,
        ...(statuses && { statuses }),
        ...(kinds && { kinds }),
        ...(severities && { severities }),
        ...(environment !== undefined && { environment }),
        ...(from && { from }),
        ...(to && { to }),
        ...(cursor !== undefined && { cursor }),
      };
      const page = await service.list(projectAccessOf(request), query);
      return {
        issues: page.issues.map(publicIssue),
        ...(page.nextCursor !== undefined && { next_cursor: page.nextCursor }),
      };
    },
  );

  app.get(
    "/api/v1/projects/:id/issues/:issue_id",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => {
      const { issue_id: issueId } = request.params as { issue_id: string };
      const { issue, latest } = await service.get(projectAccessOf(request), issueId);
      return { issue: publicIssue(issue), latest_event: latest ? publicEvent(latest) : null };
    },
  );

  for (const [action, status] of Object.entries(ISSUE_ACTIONS)) {
    app.post(
      `/api/v1/projects/:id/issues/:issue_id/${action}`,
      { ...projectRoute, config: { permission: "issues.manage" } },
      async (request) => {
        const { issue_id: issueId } = request.params as { issue_id: string };
        const access = projectAccessOf(request);
        const issue = await service.setStatus(access, issueId, status, request.ip);
        request.log.info({ project_id: access.projectId, issue_id: issue.id, status }, "issue status changed");
        return { issue: publicIssue(issue) };
      },
    );
  }
}
