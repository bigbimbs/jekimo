import type { EventKind, Severity } from "@jekimo/event-schema";
import type { IssuePeriod, IssueStatus } from "../constants/issues";

export interface IssueFilters {
  status: IssueStatus | "all";
  kind: EventKind | "all";
  severity: Severity | "all";
  period: IssuePeriod;
}

export interface StackLine {
  text: string;
  frame: boolean;
  inApp: boolean;
}
