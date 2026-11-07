import type { EventKind, Severity } from "@jekimo/event-schema";
import type { IssueStatus } from "../constants/issues.js";

export interface IssueSummary {
  fingerprint: string;
  title: string;
  kind: EventKind;
  lastSeverity: Severity;
  eventCount: number;
  firstSeen: Date;
  lastSeen: Date;
  /** The newest event of the issue; applied when lastSeen is the newest seen. */
  lastEventId?: string;
  environments?: string[];
}

export interface IssueRecord extends IssueSummary {
  /** Stable handle for the API; fingerprints can be long client strings. */
  id: string;
  projectId: string;
  status: IssueStatus;
  environments: string[];
  statusChangedAt?: Date;
}

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
