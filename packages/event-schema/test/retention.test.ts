import { describe, expect, it } from "vitest";
import {
  DISK_THRESHOLDS,
  RETENTION,
  diskLevel,
  effectiveRetentionDays,
  isExpired,
  normalizeRetentionDays,
  retentionExpiry,
} from "../src/index.js";

const received = new Date("2026-11-01T00:00:00Z");

describe("normalizeRetentionDays", () => {
  it("accepts integers within bounds", () => {
    expect(normalizeRetentionDays(1)).toBe(1);
    expect(normalizeRetentionDays(30)).toBe(30);
    expect(normalizeRetentionDays(RETENTION.MAX_DAYS)).toBe(RETENTION.MAX_DAYS);
  });

  it("rejects out-of-range, fractional, and non-numeric values", () => {
    for (const bad of [0, -1, RETENTION.MAX_DAYS + 1, 1.5, "30", null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeRetentionDays(bad), String(bad)).toBeNull();
    }
  });

  it("honours an operator-lowered maximum", () => {
    expect(normalizeRetentionDays(90, 90)).toBe(90);
    expect(normalizeRetentionDays(91, 90)).toBeNull();
  });
});

describe("expiry", () => {
  it("expires exactly retention_days after received_at", () => {
    expect(retentionExpiry(received, 30).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(isExpired(received, 30, new Date("2026-11-30T23:59:59.999Z"))).toBe(false);
    expect(isExpired(received, 30, new Date("2026-12-01T00:00:00.000Z"))).toBe(true);
  });

  it("is measured from received_at regardless of the event timestamp", () => {
    // An event claiming to be from 1999 but received today is not expired.
    expect(isExpired(received, 1, new Date("2026-11-01T12:00:00Z"))).toBe(false);
  });
});

describe("disk levels", () => {
  it("classifies free space against the default thresholds", () => {
    expect(diskLevel(50)).toBe("ok");
    expect(diskLevel(DISK_THRESHOLDS.WARN_PERCENT + 0.1)).toBe("ok");
    expect(diskLevel(DISK_THRESHOLDS.WARN_PERCENT)).toBe("warn");
    expect(diskLevel(DISK_THRESHOLDS.CRITICAL_PERCENT)).toBe("critical");
    expect(diskLevel(DISK_THRESHOLDS.FULL_PERCENT)).toBe("full");
    expect(diskLevel(0)).toBe("full");
  });

  it("fails closed when free space is unknown", () => {
    expect(diskLevel(Number.NaN)).toBe("full");
    expect(diskLevel(Number.POSITIVE_INFINITY)).toBe("full");
  });

  it("accepts operator thresholds", () => {
    const t = { WARN_PERCENT: 30, CRITICAL_PERCENT: 15, FULL_PERCENT: 8 } as const;
    expect(diskLevel(25, t)).toBe("warn");
    expect(diskLevel(12, t)).toBe("critical");
    expect(diskLevel(8, t)).toBe("full");
  });
});

describe("effectiveRetentionDays", () => {
  it("keeps the configured period while the disk is healthy or merely warning", () => {
    expect(effectiveRetentionDays(90, "ok")).toBe(90);
    expect(effectiveRetentionDays(90, "warn")).toBe(90);
  });

  it("caps at the emergency period when the disk is critical or full", () => {
    expect(effectiveRetentionDays(90, "critical")).toBe(RETENTION.EMERGENCY_DAYS);
    expect(effectiveRetentionDays(90, "full")).toBe(RETENTION.EMERGENCY_DAYS);
    expect(effectiveRetentionDays(3, "critical")).toBe(3);
  });
});
