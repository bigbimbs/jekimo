export const DEFAULT_ISSUE_LIMIT = 50;
export const MAX_ISSUE_LIMIT = 200;

export const ISSUE_ACTIONS = { resolve: "resolved", ignore: "ignored", reopen: "unresolved" } as const;
export type IssueAction = keyof typeof ISSUE_ACTIONS;
