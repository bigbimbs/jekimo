// Normative text: docs/retention.md.

import { DISK_THRESHOLDS, RETENTION } from "./constants/retention.js";
import type { DiskLevel, DiskThresholds } from "./types/retention.js";

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
