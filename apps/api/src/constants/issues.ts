/** Issues per page when `limit` is absent, and the most a request may ask for. */
export const DEFAULT_ISSUE_LIMIT = 50;
export const MAX_ISSUE_LIMIT = 200;

/** Status actions, as URL path segments, and the status each one sets. */
export const ISSUE_ACTIONS = { resolve: "resolved", ignore: "ignored", reopen: "unresolved" } as const;
export type IssueAction = keyof typeof ISSUE_ACTIONS;
