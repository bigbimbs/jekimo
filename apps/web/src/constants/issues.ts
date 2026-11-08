export { EVENT_KINDS, SEVERITIES } from "@jekimo/event-schema/constants";

export const ISSUE_STATUSES = ["unresolved", "resolved", "ignored"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_ACTIONS = ["resolve", "ignore", "reopen"] as const;
export type IssueAction = (typeof ISSUE_ACTIONS)[number];

/** Which actions each status offers. */
export const ACTIONS_FOR_STATUS: Readonly<Record<IssueStatus, readonly IssueAction[]>> = {
  unresolved: ["resolve", "ignore"],
  resolved: ["reopen"],
  ignored: ["reopen", "resolve"],
};

/** Last-seen windows for the issue list, in hours; "all" sends no time filter. */
export const ISSUE_PERIODS = { "1h": 1, "24h": 24, "7d": 168, "14d": 336, "30d": 720, all: null } as const;
export type IssuePeriod = keyof typeof ISSUE_PERIODS;

export const ISSUE_PAGE_SIZE = 50;
export const ALL = "all";
