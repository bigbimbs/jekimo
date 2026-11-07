import type { EventKind, Severity } from "@jekimo/event-schema";
import type { IssueStatus } from "../constants/index.js";
import type { IssueRecord } from "../types.js";

export interface IssueQuery {
  statuses?: IssueStatus[];
  kinds?: EventKind[];
  /** Matched against the latest event's severity. */
  severities?: Severity[];
  environment?: string;
  /** Issues last seen at or after this time. */
  from?: Date;
  /** Issues first seen before this time. */
  to?: Date;
  limit: number;
  cursor?: string;
}

export interface IssuePage {
  issues: IssueRecord[];
  nextCursor?: string;
}
