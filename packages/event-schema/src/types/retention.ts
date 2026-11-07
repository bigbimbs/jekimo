export interface DiskThresholds {
  /** Percent of free space at or below which admins are warned. */
  readonly WARN_PERCENT: number;
  /** Percent at or below which emergency expiry runs. */
  readonly CRITICAL_PERCENT: number;
  /** Percent at or below which ingestion returns 503. */
  readonly FULL_PERCENT: number;
}

export type DiskLevel = "ok" | "warn" | "critical" | "full";
