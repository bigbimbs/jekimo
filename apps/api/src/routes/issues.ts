// Permissions per docs/access-model.md, "Permission catalogue". Status
// changes are audit-logged by the storage layer.

import { EVENT_KINDS, type EventKind, LIMITS, SEVERITIES, type Severity } from "@jekimo/event-schema";
import {
  ISSUE_STATUSES,
  type IssuePage,
  type IssueQuery,
  type IssueRecord,
  type IssueStatus,
} from "@jekimo/storage-postgres";
import type { FastifyInstance } from "fastify";
import { DEFAULT_ISSUE_LIMIT, ISSUE_ACTIONS, MAX_ISSUE_LIMIT } from "../constants/index.js";
import { ApiError } from "../errors.js";
import { projectAccessOf } from "../session.js";
import type { IssueRouteOptions } from "../types/index.js";
import { parseExact, parseList, parseTime, publicEvent } from "./projects.js";

export function publicIssue(i: IssueRecord) {
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
      const limit = q.limit === undefined ? DEFAULT_ISSUE_LIMIT : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ISSUE_LIMIT) {
        throw new ApiError(400, "invalid_request", `limit must be a whole number from 1 to ${MAX_ISSUE_LIMIT}`);
      }
      const cursor = q.cursor === undefined ? undefined : String(q.cursor);
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
      let page: IssuePage;
      try {
        page = await opts.metadata.listIssues(projectAccessOf(request), query);
      } catch (err) {
        if (err instanceof RangeError) throw new ApiError(400, "invalid_request", "cursor is not valid");
        throw err;
      }
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
      const access = projectAccessOf(request);
      // Scoped to the access check's project, so another project's issue id is a 404.
      const issue = await opts.metadata.getIssue(access, issueId);
      if (!issue) throw new ApiError(404, "not_found", "issue not found");
      const latest =
        issue.lastEventId === undefined ? null : await opts.events.getEvent(access.projectId, issue.lastEventId);
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
        const issue = await opts.metadata.setIssueStatus(access, issueId, status, request.ip);
        if (!issue) throw new ApiError(404, "not_found", "issue not found");
        request.log.info({ project_id: access.projectId, issue_id: issue.id, status }, "issue status changed");
        return { issue: publicIssue(issue) };
      },
    );
  }
}
