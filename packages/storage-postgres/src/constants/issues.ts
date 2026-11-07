/** Issue statuses. `unresolved` is the status of a new or reopened issue. */
export const ISSUE_STATUSES = ["unresolved", "resolved", "ignored"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** At most this many environments are kept per issue. */
export const MAX_ISSUE_ENVIRONMENTS = 32;
