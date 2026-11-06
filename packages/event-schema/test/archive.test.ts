import { describe, expect, it } from "vitest";
import {
  archiveDayPrefix,
  archiveManifestKey,
  archivePartKey,
  HOT_DAYS,
  parseArchiveKey,
  projectPrefix,
  RETENTION,
  splitRetention,
  utcDay,
} from "../src/index.js";

describe("archive key layout", () => {
  it("builds the documented keys", () => {
    expect(projectPrefix("prj_billing")).toBe("v1/projects/prj_billing/");
    expect(archiveDayPrefix("prj_billing", "2026-11-05")).toBe("v1/projects/prj_billing/events/2026/11/05/");
    expect(archivePartKey("prj_billing", "2026-11-05", 0)).toBe(
      "v1/projects/prj_billing/events/2026/11/05/part-00000.ndjson.zst",
    );
    expect(archivePartKey("prj_billing", "2026-11-05", 42)).toBe(
      "v1/projects/prj_billing/events/2026/11/05/part-00042.ndjson.zst",
    );
    expect(archiveManifestKey("prj_billing", "2026-11-05")).toBe(
      "v1/projects/prj_billing/events/2026/11/05/manifest.json",
    );
  });

  it("keeps every project under its own prefix", () => {
    const a = projectPrefix("prj_a");
    const b = projectPrefix("prj_ab");
    expect(archivePartKey("prj_ab", "2026-11-05", 0).startsWith(a)).toBe(false);
    expect(archivePartKey("prj_a", "2026-11-05", 0).startsWith(b)).toBe(false);
  });

  it("refuses unsafe project ids and invalid days", () => {
    for (const bad of ["", "../x", "a/b", "Prj", "prj billing", "x".repeat(65), "-starts-with-dash"]) {
      expect(() => projectPrefix(bad), bad).toThrow(RangeError);
    }
    for (const bad of ["2026-13-01", "2026-02-30", "20261105", "2026-11-5", "yesterday"]) {
      expect(() => archiveDayPrefix("prj", bad), bad).toThrow(RangeError);
    }
    expect(() => archivePartKey("prj", "2026-11-05", -1)).toThrow(RangeError);
    expect(() => archivePartKey("prj", "2026-11-05", 1.5)).toThrow(RangeError);
    expect(() => archivePartKey("prj", "2026-11-05", 100000)).toThrow(RangeError);
  });

  it("round-trips through parseArchiveKey", () => {
    expect(parseArchiveKey(archivePartKey("prj_billing", "2026-11-05", 7))).toEqual({
      kind: "part",
      projectId: "prj_billing",
      day: "2026-11-05",
      part: 7,
      format: "ndjson.zst",
    });
    expect(parseArchiveKey(archiveManifestKey("prj_billing", "2026-11-05"))).toEqual({
      kind: "manifest",
      projectId: "prj_billing",
      day: "2026-11-05",
    });
  });

  it("returns null for foreign, malformed, or traversal keys without throwing", () => {
    for (const key of [
      "",
      "v1/backups/2026-11-05/021041/db.dump.zst",
      "v1/projects/prj/exports/exp_1/file.csv",
      "v1/projects/prj/events/2026/11/05/part-1.ndjson.zst",
      "v1/projects/prj/events/2026/02/30/manifest.json",
      "v1/projects/../events/2026/11/05/manifest.json",
      "v2/projects/prj/events/2026/11/05/manifest.json",
      "v1/projects/prj/events/2026/11/05/part-00000.parquet",
    ]) {
      expect(parseArchiveKey(key), key).toBeNull();
    }
  });

  it("formats UTC days", () => {
    expect(utcDay(new Date("2026-11-05T23:59:59.999Z"))).toBe("2026-11-05");
    expect(utcDay(new Date("2026-11-05T00:00:00.000+02:00"))).toBe("2026-11-04");
  });
});

describe("splitRetention", () => {
  it("without an object store the whole period is hot", () => {
    expect(splitRetention({ retentionDays: 30, objectStoreConfigured: false })).toEqual({
      ok: true,
      hotDays: 30,
      coldDays: 0,
    });
    expect(splitRetention({ retentionDays: 30, hotDays: 30, objectStoreConfigured: false })).toEqual({
      ok: true,
      hotDays: 30,
      coldDays: 0,
    });
    expect(splitRetention({ retentionDays: 30, hotDays: 7, objectStoreConfigured: false })).toEqual({
      ok: false,
      reason: "cold_tier_unavailable",
    });
  });

  it("with an object store the hot period defaults to 14 days, capped by the total", () => {
    expect(splitRetention({ retentionDays: 90, objectStoreConfigured: true })).toEqual({
      ok: true,
      hotDays: HOT_DAYS.DEFAULT_WITH_OBJECT_STORE,
      coldDays: 76,
    });
    expect(splitRetention({ retentionDays: 7, objectStoreConfigured: true })).toEqual({
      ok: true,
      hotDays: 7,
      coldDays: 0,
    });
    expect(splitRetention({ retentionDays: 365, hotDays: 30, objectStoreConfigured: true })).toEqual({
      ok: true,
      hotDays: 30,
      coldDays: 335,
    });
  });

  it("rejects out-of-range values", () => {
    expect(splitRetention({ retentionDays: 0, objectStoreConfigured: true }).ok).toBe(false);
    expect(splitRetention({ retentionDays: RETENTION.MAX_DAYS + 1, objectStoreConfigured: true })).toEqual({
      ok: false,
      reason: "invalid_retention",
    });
    expect(splitRetention({ retentionDays: 90, hotDays: 0, objectStoreConfigured: true })).toEqual({
      ok: false,
      reason: "invalid_hot_days",
    });
    expect(splitRetention({ retentionDays: 90, hotDays: 2.5, objectStoreConfigured: true })).toEqual({
      ok: false,
      reason: "invalid_hot_days",
    });
    expect(splitRetention({ retentionDays: 400, hotDays: HOT_DAYS.MAX + 1, objectStoreConfigured: true })).toEqual({
      ok: false,
      reason: "invalid_hot_days",
    });
    expect(splitRetention({ retentionDays: 30, hotDays: 31, objectStoreConfigured: true })).toEqual({
      ok: false,
      reason: "hot_exceeds_retention",
    });
  });

  it("honours operator maximums", () => {
    expect(splitRetention({ retentionDays: 120, objectStoreConfigured: true, maxRetentionDays: 90 })).toEqual({
      ok: false,
      reason: "invalid_retention",
    });
    expect(splitRetention({ retentionDays: 90, hotDays: 60, objectStoreConfigured: true, maxHotDays: 30 })).toEqual({
      ok: false,
      reason: "invalid_hot_days",
    });
  });
});
