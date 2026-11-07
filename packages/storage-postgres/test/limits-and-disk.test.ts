/**
 * Ingestion limits and disk probes. The PostgreSQL part is skipped unless
 * JEKIMO_DATABASE_URL (or the deprecated DATABASE_URL) is set.
 */

import { tmpdir } from "node:os";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkIngestLimitSettings,
  DiskMonitor,
  databaseBudgetDiskProbe,
  decideCharge,
  diskConfigFromEnv,
  type IngestLimits,
  PostgresIngestLimitStore,
  PostgresMetadataRepository,
  secondsUntilNextMinute,
  secondsUntilNextUtcDay,
  statfsDiskProbe,
} from "../src/index.js";
import { createTestDatabase, hasDatabase, type TestDatabase } from "../src/testing.js";

const at = (iso: string) => new Date(iso);
const LIMITS: IngestLimits = { ratePerMinute: 100, eventsPerDay: 1000 };

describe("decideCharge", () => {
  const now = at("2026-11-05T09:15:30.000Z");

  it("admits up to the limit and refuses limit + 1", () => {
    const first = decideCharge(null, now, 100, LIMITS);
    expect(first.outcome).toBe("admitted");
    expect(first.next).toMatchObject({ minuteEvents: 100, dayEvents: 100, day: "2026-11-05" });
    const second = decideCharge(first.next, now, 1, LIMITS);
    expect(second.outcome).toBe("rate_limited");
    expect(second.next).toMatchObject({ minuteEvents: 100, dayEvents: 100 });
  });

  it("starts a new window each UTC minute and a new day at midnight", () => {
    const full = decideCharge(null, now, 100, LIMITS).next;
    const nextMinute = decideCharge(full, at("2026-11-05T09:16:00.000Z"), 100, LIMITS);
    expect(nextMinute.outcome).toBe("admitted");
    expect(nextMinute.next).toMatchObject({ minuteEvents: 100, dayEvents: 200 });
    const nextDay = decideCharge({ ...full, dayEvents: 1000 }, at("2026-11-06T00:00:00.000Z"), 1, LIMITS);
    expect(nextDay.outcome).toBe("admitted");
    expect(nextDay.next).toMatchObject({ day: "2026-11-06", dayEvents: 1 });
  });

  it("checks the quota first and still counts refused events toward the minute", () => {
    const row = { ...decideCharge(null, now, 10, LIMITS).next, dayEvents: 995 };
    const over = decideCharge(row, now, 6, LIMITS);
    expect(over.outcome).toBe("quota_exceeded");
    expect(over.next).toMatchObject({ minuteEvents: 16, dayEvents: 995 });
    expect(decideCharge(row, now, 5, LIMITS).outcome).toBe("admitted");
  });

  it("has no quota when eventsPerDay is null", () => {
    expect(decideCharge(null, now, 100, { ratePerMinute: 100, eventsPerDay: null }).outcome).toBe("admitted");
  });

  it("computes Retry-After values in whole seconds, at least 1", () => {
    expect(secondsUntilNextMinute(at("2026-11-05T09:15:00.000Z"))).toBe(60);
    expect(secondsUntilNextMinute(at("2026-11-05T09:15:59.999Z"))).toBe(1);
    expect(secondsUntilNextMinute(at("2026-11-05T09:15:44.100Z"))).toBe(16);
    expect(secondsUntilNextUtcDay(at("2026-11-05T23:59:59.500Z"))).toBe(1);
    expect(secondsUntilNextUtcDay(at("2026-11-05T00:00:00.000Z"))).toBe(86_400);
  });

  it("validates settings", () => {
    expect(checkIngestLimitSettings({ rateLimitPerMinute: null, eventsPerDay: null })).toEqual({
      rateLimitPerMinute: null,
      eventsPerDay: null,
    });
    expect(() => checkIngestLimitSettings({ rateLimitPerMinute: 99, eventsPerDay: null })).toThrow(RangeError);
    expect(() => checkIngestLimitSettings({ rateLimitPerMinute: null, eventsPerDay: 1.5 })).toThrow(RangeError);
  });
});

describe("diskConfigFromEnv", () => {
  it("uses the documented defaults", () => {
    expect(diskConfigFromEnv({})).toEqual({
      thresholds: { WARN_PERCENT: 20, CRITICAL_PERCENT: 10, FULL_PERCENT: 5 },
      path: "/",
      budgetBytes: null,
    });
  });

  it("reads overrides", () => {
    expect(
      diskConfigFromEnv({
        JEKIMO_DISK_WARN_PERCENT: "30",
        JEKIMO_DISK_CRITICAL_PERCENT: "15",
        JEKIMO_DISK_FULL_PERCENT: "2.5",
        JEKIMO_DISK_PATH: "/var/lib/jekimo/db",
        JEKIMO_DISK_BUDGET_BYTES: "1000000",
      }),
    ).toEqual({
      thresholds: { WARN_PERCENT: 30, CRITICAL_PERCENT: 15, FULL_PERCENT: 2.5 },
      path: "/var/lib/jekimo/db",
      budgetBytes: 1_000_000,
    });
  });

  it.each([
    [{ JEKIMO_DISK_FULL_PERCENT: "101" }, "JEKIMO_DISK_FULL_PERCENT must be a number from 0 to 100"],
    [{ JEKIMO_DISK_WARN_PERCENT: "5" }, "JEKIMO_DISK_WARN_PERCENT must be at least JEKIMO_DISK_CRITICAL_PERCENT"],
    [{ JEKIMO_DISK_CRITICAL_PERCENT: "4" }, "JEKIMO_DISK_CRITICAL_PERCENT must be at least JEKIMO_DISK_FULL_PERCENT"],
    [{ JEKIMO_DISK_BUDGET_BYTES: "0" }, "JEKIMO_DISK_BUDGET_BYTES must be a positive integer"],
  ])("rejects %o", (env, message) => {
    expect(() => diskConfigFromEnv(env)).toThrow(message);
  });
});

describe("DiskMonitor", () => {
  it("classifies each level", async () => {
    for (const [free, level] of [
      [50, "ok"],
      [20, "warn"],
      [10, "critical"],
      [5, "full"],
    ] as const) {
      const status = await new DiskMonitor({ probe: async () => free }).status();
      expect(status).toMatchObject({ level, freePercent: free });
    }
  });

  it("fails closed when the probe throws or hangs", async () => {
    const errors: unknown[] = [];
    const failing = new DiskMonitor({
      probe: async () => {
        throw new Error("no such file");
      },
      onError: (e) => errors.push(e),
    });
    expect(await failing.status()).toMatchObject({ level: "full", freePercent: null });
    expect(errors).toEqual([{ type: "Error", message: "no such file" }]);
    const hanging = new DiskMonitor({ probe: () => new Promise<number>(() => {}), timeoutMs: 10 });
    expect(await hanging.status()).toMatchObject({ level: "full", freePercent: null });
    const nan = new DiskMonitor({ probe: async () => Number.NaN });
    expect((await nan.status()).level).toBe("full");
  });

  it("reuses a reading for cacheMs and shares one probe between callers", async () => {
    let calls = 0;
    let now = 0;
    const monitor = new DiskMonitor({
      probe: async () => {
        calls++;
        return 50;
      },
      cacheMs: 1000,
      clock: () => new Date(now),
    });
    await Promise.all([monitor.status(), monitor.status()]);
    expect(calls).toBe(1);
    now = 999;
    await monitor.status();
    expect(calls).toBe(1);
    now = 1000;
    await monitor.status();
    expect(calls).toBe(2);
  });

  it("reads a real filesystem with statfs", async () => {
    const free = await statfsDiskProbe(tmpdir())();
    expect(free).toBeGreaterThanOrEqual(0);
    expect(free).toBeLessThanOrEqual(100);
    await expect(statfsDiskProbe("/no/such/jekimo/path")()).rejects.toThrow();
  });
});

describe.skipIf(!hasDatabase)("ingestion limits on PostgreSQL", () => {
  let db: TestDatabase;
  let store: PostgresIngestLimitStore;
  let metadata: PostgresMetadataRepository;
  let actorId: string;
  let adminId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    store = new PostgresIngestLimitStore(db.pool);
    metadata = new PostgresMetadataRepository(db.pool);
    const owner = await metadata.createFirstAdmin({ email: "admin@example.test", passwordHash: "x" });
    adminId = owner!.id;
    actorId = adminId;
    await metadata.createProject(
      { userId: actorId, instanceRole: "admin" },
      { id: "prj_a", name: "A", retentionDays: 30 },
    );
    await metadata.createProject(
      { userId: actorId, instanceRole: "admin" },
      { id: "prj_b", name: "B", retentionDays: 30 },
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  it("reads settings and zero usage for a new project, and null for an unknown one", async () => {
    expect(await store.read("prj_a", at("2026-11-05T09:15:00.000Z"))).toEqual({
      rateLimitPerMinute: null,
      eventsPerDay: null,
      minuteEvents: 0,
      dayEvents: 0,
    });
    expect(await store.read("prj_missing", new Date())).toBeNull();
  });

  it("admits exactly the limit under concurrent requests from separate pools", async () => {
    // A second pool on the same schema stands in for a second API process.
    const other = new pg.Pool({
      connectionString: process.env.JEKIMO_DATABASE_URL || process.env.DATABASE_URL,
      max: 5,
      options: `-c search_path=${db.schema}`,
    });
    const otherStore = new PostgresIngestLimitStore(other);
    const now = at("2026-11-05T10:00:10.000Z");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? store : otherStore).charge("prj_a", now, 10, LIMITS)),
    );
    await other.end();
    expect(results.filter((r) => r.outcome === "admitted")).toHaveLength(10);
    expect(results.filter((r) => r.outcome === "rate_limited")).toHaveLength(10);
    expect(await store.read("prj_a", now)).toMatchObject({ minuteEvents: 100, dayEvents: 100 });
    // A new store, as after a restart, sees the same window.
    expect((await new PostgresIngestLimitStore(db.pool).charge("prj_a", now, 1, LIMITS)).outcome).toBe("rate_limited");
    // The next minute starts empty; the day carries on.
    const later = at("2026-11-05T10:01:00.000Z");
    expect(await store.read("prj_a", later)).toMatchObject({ minuteEvents: 0, dayEvents: 100 });
    expect(await store.charge("prj_a", later, 100, LIMITS)).toEqual({
      outcome: "admitted",
      minuteEvents: 100,
      dayEvents: 200,
    });
  });

  it("refuses over quota until the UTC day changes", async () => {
    const limits = { ratePerMinute: 1000, eventsPerDay: 50 };
    const now = at("2026-11-05T23:59:00.000Z");
    expect((await store.charge("prj_b", now, 50, limits)).outcome).toBe("admitted");
    expect(await store.charge("prj_b", now, 1, limits)).toEqual({
      outcome: "quota_exceeded",
      minuteEvents: 51,
      dayEvents: 50,
    });
    expect((await store.charge("prj_b", at("2026-11-06T00:00:01.000Z"), 1, limits)).outcome).toBe("admitted");
  });

  it("stores settings for instance admins only, with an audit entry", async () => {
    const admin = { userId: adminId, instanceRole: "admin" as const };
    const access = await metadata.resolveProjectAccess(admin, "prj_a");
    expect(await store.setSettings(admin, access!, { rateLimitPerMinute: 200, eventsPerDay: 5000 })).toEqual({
      rateLimitPerMinute: 200,
      eventsPerDay: 5000,
    });
    expect(await store.getSettings(access!)).toEqual({ rateLimitPerMinute: 200, eventsPerDay: 5000 });
    expect(await store.read("prj_a", new Date())).toMatchObject({ rateLimitPerMinute: 200, eventsPerDay: 5000 });
    const { rows } = await db.pool.query(
      "SELECT details FROM audit_log WHERE action = 'project.ingest_limits_updated' AND project_id = 'prj_a'",
    );
    expect(rows[0].details).toEqual({ rate_limit_per_minute: 200, events_per_day: 5000 });

    await expect(
      store.setSettings({ userId: adminId, instanceRole: "member" }, access!, {
        rateLimitPerMinute: null,
        eventsPerDay: null,
      }),
    ).rejects.toThrow("only instance admins");
    await expect(store.setSettings(admin, access!, { rateLimitPerMinute: 50, eventsPerDay: null })).rejects.toThrow(
      RangeError,
    );
  });

  it("measures the database against a budget", async () => {
    const { rows } = await db.pool.query<{ size: string }>("SELECT pg_database_size(current_database()) AS size");
    const size = Number(rows[0]!.size);
    // Other test schemas share the database, so its size can move a little.
    const half = await databaseBudgetDiskProbe(db.pool, size * 2)();
    expect(half).toBeGreaterThan(40);
    expect(half).toBeLessThanOrEqual(50);
    expect(await databaseBudgetDiskProbe(db.pool, Math.floor(size / 2))()).toBe(0);
  });
});
