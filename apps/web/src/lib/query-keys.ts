import type { AuditQuery, EventQuery } from "../types/api";
import type { IssueFilters } from "../types/issues";

// Every query with project data starts with ["project", id], so leaving a
// project can drop all of it at once (docs/access-model.md, "Authorization
// enforcement", rule 6: the id only routes; the server decides access).
export const queryKeys = {
  eventSummary: (projectId: string) => ["project", projectId, "event-summary"] as const,
  events: (projectId: string, query: EventQuery) => ["project", projectId, "events", query] as const,
  event: (projectId: string, eventId: string) => ["project", projectId, "event", eventId] as const,
  recentIssues: (projectId: string) => ["project", projectId, "issues", "recent"] as const,
  audit: (query: AuditQuery) => ["admin", "audit", query] as const,
  auditActions: ["admin", "audit-actions"] as const,
  invitations: ["admin", "invitations"] as const,
  users: ["admin", "users"] as const,
  twoFactor: ["two-factor"] as const,
  session: ["session"] as const,
  setup: ["setup"] as const,
  projects: ["projects"] as const,
  project: (projectId: string) => ["project", projectId] as const,
  members: (projectId: string) => ["project", projectId, "members"] as const,
  roles: (projectId: string) => ["project", projectId, "roles"] as const,
  permissions: (projectId: string, userId: string) => ["project", projectId, "permissions", userId] as const,
  issues: (projectId: string, filters?: IssueFilters) =>
    filters ? (["project", projectId, "issues", filters] as const) : (["project", projectId, "issues"] as const),
  issue: (projectId: string, issueId: string) => ["project", projectId, "issue", issueId] as const,
  keys: (projectId: string) => ["project", projectId, "keys"] as const,
};
