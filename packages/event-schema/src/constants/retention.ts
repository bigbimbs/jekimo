import type { DiskThresholds } from "../types/retention.js";

/** Normative text: docs/retention.md. */
export const RETENTION = {
  /** Retention for new projects, in days. */
  DEFAULT_DAYS: 30,
  MIN_DAYS: 1,
  /** Absolute upper bound; operators may lower it instance-wide. */
  MAX_DAYS: 3650,
  /** Retention applied to every project during emergency expiry. */
  EMERGENCY_DAYS: 7,
  /**
   * Minimum time stored event_ids are remembered for deduplication, from
   * received_at. Checked at append to the event store, not at enqueue.
   */
  DEDUPE_WINDOW_DAYS: 7,
  /** Grace period in which a deleted project can be restored. */
  PROJECT_DELETE_GRACE_DAYS: 7,
  AUDIT_LOG_DAYS: 365,
} as const;

export const DISK_THRESHOLDS: DiskThresholds = {
  WARN_PERCENT: 20,
  CRITICAL_PERCENT: 10,
  FULL_PERCENT: 5,
};
