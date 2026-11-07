/**
 * Retention constants and helpers. Normative text: docs/retention.md.
 */

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

export interface DiskThresholds {
  /** Percent of free space at or below which admins are warned. */
  readonly WARN_PERCENT: number;
  /** Percent at or below which emergency expiry runs. */
  readonly CRITICAL_PERCENT: number;
  /** Percent at or below which ingestion returns 503. */
  readonly FULL_PERCENT: number;
}

export const DISK_THRESHOLDS: DiskThresholds = {
  WARN_PERCENT: 20,
  CRITICAL_PERCENT: 10,
  FULL_PERCENT: 5,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Validates a retention period. Returns the integer number of days when it
 * lies within [RETENTION.MIN_DAYS, maxDays], otherwise null.
 */
export function normalizeRetentionDays(value: unknown, maxDays: number = RETENTION.MAX_DAYS): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < RETENTION.MIN_DAYS || value > maxDays) return null;
  return value;
}

/** The instant at which an event received at `receivedAt` expires. */
export function retentionExpiry(receivedAt: Date, retentionDays: number): Date {
  return new Date(receivedAt.getTime() + retentionDays * DAY_MS);
}

/** True once `now` has reached the event's expiry. Retention is measured from `receivedAt`, never from the event's own timestamp. */
export function isExpired(receivedAt: Date, retentionDays: number, now: Date = new Date()): boolean {
  return now.getTime() >= retentionExpiry(receivedAt, retentionDays).getTime();
}

export type DiskLevel = "ok" | "warn" | "critical" | "full";

/**
 * Classifies free disk space. `thresholds` lets operators override the
 * defaults; each must be a percentage in [0, 100] with warn >= critical >= full.
 */
export function diskLevel(freePercent: number, thresholds: DiskThresholds = DISK_THRESHOLDS): DiskLevel {
  if (!Number.isFinite(freePercent)) return "full"; // fail closed when free space is unknown
  if (freePercent <= thresholds.FULL_PERCENT) return "full";
  if (freePercent <= thresholds.CRITICAL_PERCENT) return "critical";
  if (freePercent <= thresholds.WARN_PERCENT) return "warn";
  return "ok";
}

/**
 * Retention to apply during an expiry pass given the disk level: the
 * configured period normally, and min(configured, EMERGENCY_DAYS) when the
 * disk is critical or full.
 */
export function effectiveRetentionDays(configuredDays: number, level: DiskLevel): number {
  if (level === "critical" || level === "full") return Math.min(configuredDays, RETENTION.EMERGENCY_DAYS);
  return configuredDays;
}
