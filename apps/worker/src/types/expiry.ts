export interface ExpiryOptions {
  /** Disk at the critical level: retention is min(configured, 7 days) (docs/retention.md, "Disk safety"). */
  emergency?: boolean;
  /** Recount every project's issues, for the pass after a crashed or failed one. */
  recountAll?: boolean;
  retentionDefaultDays?: number;
  retentionMaxDays?: number;
}
