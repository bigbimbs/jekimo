import type { EventKind, Severity } from "@jekimo/event-schema";
import type { IssueStatus } from "../constants/index.js";
import type { IssueRecord } from "../types.js";

export interface IssueQuery {
  /** Any of these statuses. */
  statuses?: IssueStatus[];
  /** Any of these kinds. */
  kinds?: EventKind[];
  /** Any of these severities, matched against the latest event's severity. */
  severities?: Severity[];
  /** Issues with at least one event in this environment. */
  environment?: string;
  /** Issues last seen at or after this time. */
  from?: Date;
  /** Issues first seen before this time. */
  to?: Date;
  limit: number;
  /** Opaque cursor from a previous page's nextCursor. */
  cursor?: string;
}

export interface IssuePage {
  issues: IssueRecord[];
  nextCursor?: string;
}
