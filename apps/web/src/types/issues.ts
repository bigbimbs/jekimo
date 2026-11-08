import type { EventKind, Severity } from "@jekimo/event-schema";
import type { IssuePeriod, IssueStatus } from "../constants/issues";

export interface IssueFilters {
  status: IssueStatus | "all";
  kind: EventKind | "all";
  severity: Severity | "all";
  period: IssuePeriod;
}

/** A V8 frame split for display: `at <fn> (<location><position>)`. */
export interface StackFrameParts {
  lead: string;
  fn: string;
  location: string;
  position: string;
}

export interface StackLine {
  text: string;
  frame: boolean;
  inApp: boolean;
  parts?: StackFrameParts;
}
