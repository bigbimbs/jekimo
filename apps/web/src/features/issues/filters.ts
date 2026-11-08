import { ALL, EVENT_KINDS, ISSUE_PERIODS, ISSUE_STATUSES, SEVERITIES } from "../../constants/issues";
import type { IssueQuery } from "../../types/api";
import type { IssueFilters } from "../../types/issues";

export const DEFAULT_FILTERS: IssueFilters = { status: "unresolved", kind: ALL, severity: ALL, period: ALL };

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === value) ?? fallback;
}

export function filtersFromParams(params: URLSearchParams): IssueFilters {
  return {
    status: pick(params.get("status"), [...ISSUE_STATUSES, ALL], DEFAULT_FILTERS.status),
    kind: pick(params.get("kind"), [...EVENT_KINDS, ALL], DEFAULT_FILTERS.kind),
    severity: pick(params.get("severity"), [...SEVERITIES, ALL], DEFAULT_FILTERS.severity),
    period: pick(
      params.get("period"),
      Object.keys(ISSUE_PERIODS) as (keyof typeof ISSUE_PERIODS)[],
      DEFAULT_FILTERS.period,
    ),
  };
}

export function filtersToParams(filters: IssueFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value !== DEFAULT_FILTERS[name as keyof IssueFilters]) params.set(name, value);
  }
  return params;
}

export function issueQuery(
  filters: IssueFilters,
  limit: number,
  cursor: string | undefined,
  now = Date.now(),
): IssueQuery {
  const hours = ISSUE_PERIODS[filters.period];
  return {
    limit,
    ...(filters.status !== ALL && { status: filters.status }),
    ...(filters.kind !== ALL && { kind: filters.kind }),
    ...(filters.severity !== ALL && { severity: filters.severity }),
    ...(hours !== null && { from: new Date(now - hours * 3_600_000).toISOString() }),
    ...(cursor !== undefined && { cursor }),
  };
}
