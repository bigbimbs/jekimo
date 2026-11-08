import type { IssueFilters } from "../types/issues";

// Every query with project data starts with ["project", id], so leaving a
// project can drop all of it at once (docs/access-model.md, "Authorization
// enforcement", rule 6: the id only routes; the server decides access).
export const queryKeys = {
  session: ["session"] as const,
  setup: ["setup"] as const,
  projects: ["projects"] as const,
  project: (projectId: string) => ["project", projectId] as const,
  permissions: (projectId: string, userId: string) => ["project", projectId, "permissions", userId] as const,
  issues: (projectId: string, filters?: IssueFilters) =>
    filters ? (["project", projectId, "issues", filters] as const) : (["project", projectId, "issues"] as const),
  issue: (projectId: string, issueId: string) => ["project", projectId, "issue", issueId] as const,
  keys: (projectId: string) => ["project", projectId, "keys"] as const,
};
