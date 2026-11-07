/**
 * Integration tests against a real PostgreSQL. Skipped unless
 * JEKIMO_DATABASE_URL (or the deprecated DATABASE_URL) is set; CI starts a PostgreSQL 16 service container so they run there.
 */

import { utcDay } from "@jekimo/event-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MESSAGE_VECTOR } from "../src/event-store.js";
import {
  type AppendEvent,
  loadMigrations,
  migrate,
  PostgresEventStore,
  PostgresMetadataRepository,
  PostgresQueue,
  QueueFullError,
  runMigrations,
} from "../src/index.js";
import { createTestDatabase, hasDatabase, type TestDatabase } from "../src/testing.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeEvent(
  projectId: string,
  eventId: string,
  receivedAt: Date,
  overrides: Partial<AppendEvent["event"]> = {},
): AppendEvent {
  return {
    receivedAt,
    keyId: "0123456789AB",
    skewMs: -15,
    event: {
      schema_version: 1,
      event_id: eventId,
      project_id: projectId,
      timestamp: "2026-11-05T09:14:33.412Z",
      kind: "log",
      severity: "info",
      message: "synthetic test event",
      fingerprint: "fp-1",
      context: { request_id: "req_test" },
      attributes: { retry_count: 2, nested: { ok: true } },
      ...overrides,
    },
  };
}

describe.skipIf(!hasDatabase)("PostgreSQL storage", () => {
  let db: TestDatabase;
  let store: PostgresEventStore;
  let meta: PostgresMetadataRepository;

  beforeAll(async () => {
    db = await createTestDatabase();
    store = new PostgresEventStore(db.pool);
    meta = new PostgresMetadataRepository(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("is idempotent on (project_id, event_id) across appends and received days", async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - DAY_MS);
    const first = await store.appendEvents("prj_idem", [
      makeEvent("prj_idem", "01JBQ4Z3H8X9T2K7M5N6P8R9SV", yesterday),
    ]);
    expect(first.inserted).toEqual(["01JBQ4Z3H8X9T2K7M5N6P8R9SV"]);
    // A retry stamped with a different received_at still stores nothing new.
    const again = await store.appendEvents("prj_idem", [
      makeEvent("prj_idem", "01JBQ4Z3H8X9T2K7M5N6P8R9SV", now),
      makeEvent("prj_idem", "01JBQ50A6D2V8W4Y1Z3X5C7B9N", now),
    ]);
    expect(again.inserted).toEqual(["01JBQ50A6D2V8W4Y1Z3X5C7B9N"]);
    const page = await store.queryEvents("prj_idem", {
      from: new Date(now.getTime() - 2 * DAY_MS),
      to: new Date(now.getTime() + 1000),
      limit: 10,
    });
    expect(page.events.map((e) => e.event.event_id)).toEqual([
      "01JBQ50A6D2V8W4Y1Z3X5C7B9N",
      "01JBQ4Z3H8X9T2K7M5N6P8R9SV",
    ]);
    // The same event_id in another project is a different event.
    expect(
      (await store.appendEvents("prj_other", [makeEvent("prj_other", "01JBQ4Z3H8X9T2K7M5N6P8R9SV", now)])).inserted,
    ).toHaveLength(1);
  });

  it("round-trips the stored envelope and scopes queries to one project", async () => {
    const at = new Date();
    await store.appendEvents("prj_rt", [
      makeEvent("prj_rt", "01JBQ60000000000000000000A", at, {
        kind: "exception",
        severity: "error",
        exception: {
          type: "DatabaseError",
          value: "synthetic",
          stacktrace: "DatabaseError: synthetic\n    at f (/app/src/a.ts:1:1)",
        },
        sdk: { name: "@jekimo/sdk-node", version: "0.1.0" },
        service: "billing-api",
      }),
    ]);
    const page = await store.queryEvents("prj_rt", {
      from: new Date(at.getTime() - 1000),
      to: new Date(at.getTime() + 1000),
      limit: 10,
      severities: ["error"],
    });
    expect(page.events).toHaveLength(1);
    const stored = page.events[0]!;
    expect(stored.skewMs).toBe(-15);
    expect(stored.event).toMatchObject({
      project_id: "prj_rt",
      exception: { type: "DatabaseError", value: "synthetic" },
      sdk: { name: "@jekimo/sdk-node", version: "0.1.0" },
      attributes: { retry_count: 2, nested: { ok: true } },
    });
    expect(
      (
        await store.queryEvents("prj_rt", {
          from: new Date(at.getTime() - 1000),
          to: new Date(at.getTime() + 1000),
          limit: 10,
          severities: ["debug"],
        })
      ).events,
    ).toHaveLength(0);
    expect(
      (await store.queryEvents("prj_nobody", { from: new Date(0), to: new Date(at.getTime() + 1000), limit: 10 }))
        .events,
    ).toHaveLength(0);
  });

  it("pages with a cursor", async () => {
    const base = Date.now();
    const ids = ["01JBQ70000000000000000000A", "01JBQ70000000000000000000B", "01JBQ70000000000000000000C"];
    await store.appendEvents(
      "prj_page",
      ids.map((id, i) => makeEvent("prj_page", id, new Date(base + i))),
    );
    const q = { from: new Date(base - 1000), to: new Date(base + 1000), limit: 2 };
    const p1 = await store.queryEvents("prj_page", q);
    expect(p1.events.map((e) => e.event.event_id)).toEqual([ids[2], ids[1]]);
    const p2 = await store.queryEvents("prj_page", { ...q, cursor: p1.nextCursor! });
    expect(p2.events.map((e) => e.event.event_id)).toEqual([ids[0]]);
    expect(p2.nextCursor).toBeUndefined();
  });

  it("expires one project's day, keeps others, and drops the emptied partition", async () => {
    const old = new Date(Date.now() - 40 * DAY_MS);
    const day = utcDay(old);
    await store.appendEvents("prj_exp_a", [makeEvent("prj_exp_a", "01JBQ80000000000000000000A", old)]);
    await store.appendEvents("prj_exp_b", [makeEvent("prj_exp_b", "01JBQ80000000000000000000B", old)]);
    expect(await store.listDays()).toContain(day);
    expect(await store.expireDay("prj_exp_a", day)).toEqual({ deleted: 1 });
    expect(await store.expireDay("prj_exp_a", day)).toEqual({ deleted: 0 });
    expect(await store.listDays()).toContain(day);
    expect(await store.expireDay("prj_exp_b", day)).toEqual({ deleted: 1 });
    expect(await store.listDays()).not.toContain(day);
    expect(await store.expireDay("prj_exp_b", day)).toEqual({ deleted: 0 });
  });

  it("detaches a day only one project used, so an interrupted run hides the whole day", async () => {
    const old = new Date(Date.now() - 41 * DAY_MS);
    const day = utcDay(old);
    const part = `events_${day.replaceAll("-", "")}`;
    const window = { from: new Date(old.getTime() - DAY_MS), to: new Date(old.getTime() + DAY_MS), limit: 10 };
    await store.appendEvents("prj_det", [
      makeEvent("prj_det", "01JBQ81000000000000000000A", old),
      makeEvent("prj_det", "01JBQ81000000000000000000B", old),
    ]);
    // A run that died after its detach committed, before the drop.
    await db.pool.query(`ALTER TABLE events DETACH PARTITION "${part}"`);
    expect((await store.queryEvents("prj_det", window)).events).toHaveLength(0);
    expect(await store.getEvent("prj_det", "01JBQ81000000000000000000A")).toBeNull();
    // The leftover is still reported, so the next pass finishes the job, and
    // another project's run leaves it for its owner.
    expect(await store.listDays()).toContain(day);
    expect(await store.expireDay("prj_someone_else", day)).toEqual({ deleted: 0 });
    expect(await store.listDays()).toContain(day);
    expect(await store.expireDay("prj_det", day)).toEqual({ deleted: 2 });
    expect(await store.listDays()).not.toContain(day);
    const left = await db.pool.query("SELECT to_regclass($1) AS t", [part]);
    expect(left.rows[0].t).toBeNull();
  });

  it("deletes from a shared day atomically and never detaches today", async () => {
    const now = new Date();
    const today = utcDay(now);
    await store.appendEvents("prj_today_a", [makeEvent("prj_today_a", "01JBQ82000000000000000000A", now)]);
    await store.appendEvents("prj_today_b", [makeEvent("prj_today_b", "01JBQ82000000000000000000B", now)]);
    expect(await store.expireDay("prj_today_a", today)).toEqual({ deleted: 1 });
    expect(await store.getEvent("prj_today_a", "01JBQ82000000000000000000A")).toBeNull();
    expect(await store.getEvent("prj_today_b", "01JBQ82000000000000000000B")).not.toBeNull();
    expect(await store.expireDay("prj_today_b", today)).toEqual({ deleted: 1 });
    // Appends keep arriving today, so its partition stays attached.
    expect(await store.listDays()).toContain(today);
    const attached = await db.pool.query("SELECT relispartition FROM pg_class WHERE oid = to_regclass($1)", [
      `events_${today.replaceAll("-", "")}`,
    ]);
    expect(attached.rows[0].relispartition).toBe(true);
  });

  it("filters by kind, severity, environment, release, fingerprint, and words of the message", async () => {
    const base = Date.now();
    const p = "prj_filter";
    const ids = (n: number[]) => n.map((i) => `01JBQ83000000000000000000${String.fromCharCode(64 + i)}`);
    const [a, b, c, d] = ids([1, 2, 3, 4]) as [string, string, string, string];
    await store.appendEvents(p, [
      makeEvent(p, a, new Date(base + 1), {
        kind: "exception",
        severity: "error",
        message: "Database request failed while charging invoice",
        environment: "production",
        release: "billing@1.4.2",
        fingerprint: "fp-db",
      }),
      makeEvent(p, b, new Date(base + 2), {
        message: "Invoice charged",
        environment: "staging",
        release: "billing@1.4.2",
        fingerprint: "fp-ok",
      }),
      makeEvent(p, c, new Date(base + 3), {
        kind: "event",
        message: "connect to db.internal timed out",
        environment: "production",
        release: "billing@1.5.0",
        fingerprint: "fp-db",
      }),
      makeEvent(p, d, new Date(base + 4), { severity: "warning", message: "Retrying charge-invoice job" }),
    ]);
    await store.appendEvents("prj_filter_other", [
      makeEvent("prj_filter_other", "01JBQ83000000000000000000Z", new Date(base + 5), { message: "invoice" }),
    ]);
    const q = { from: new Date(base - 1000), to: new Date(base + 1000), limit: 10 };
    const find = async (extra: Partial<Parameters<typeof store.queryEvents>[1]>) =>
      (await store.queryEvents(p, { ...q, ...extra })).events.map((e) => e.event.event_id);
    expect(await find({ kinds: ["exception"] })).toEqual([a]);
    expect(await find({ kinds: ["log", "event"] })).toEqual([d, c, b]);
    expect(await find({ severities: ["info"] })).toEqual([c, b]);
    expect(await find({ environment: "production" })).toEqual([c, a]);
    expect(await find({ release: "billing@1.4.2" })).toEqual([b, a]);
    expect(await find({ fingerprint: "fp-db" })).toEqual([c, a]);
    expect(await find({ text: "invoice" })).toEqual([d, b, a]);
    expect(await find({ text: "INVOICE database" })).toEqual([a]);
    expect(await find({ text: "internal" })).toEqual([c]);
    expect(await find({ text: "db.internal" })).toEqual([c]);
    expect(await find({ text: "invoic" })).toEqual([]);
    expect(await find({ environment: "production", kinds: ["event"], text: "db" })).toEqual([c]);
    await expect(find({ text: "!?" })).rejects.toThrow(RangeError);
    expect(store.capabilities.textSearch).toBe(true);
  });

  it("serves text search from the message index", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query(
        `EXPLAIN SELECT event_id FROM events
         WHERE ${MESSAGE_VECTOR} @@ plainto_tsquery('simple', 'invoice')`,
      );
      expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/Bitmap Index Scan on \S*to_tsvector/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("looks up one event by (project, event_id) and never across projects", async () => {
    const at = new Date();
    await store.appendEvents("prj_get_a", [makeEvent("prj_get_a", "01JBQ84000000000000000000A", at)]);
    await store.appendEvents("prj_get_b", [
      makeEvent("prj_get_b", "01JBQ84000000000000000000B", at, { message: "only b" }),
    ]);
    const found = await store.getEvent("prj_get_a", "01JBQ84000000000000000000A");
    expect(found?.event).toMatchObject({ project_id: "prj_get_a", event_id: "01JBQ84000000000000000000A" });
    expect(found?.keyId).toBe("0123456789AB");
    expect(await store.getEvent("prj_get_a", "01JBQ84000000000000000000B")).toBeNull();
    expect(await store.getEvent("prj_get_a", "01JBQ84000000000000000000C")).toBeNull();
  });

  it("summarizes fingerprints from the event store", async () => {
    const at = new Date();
    await store.appendEvents("prj_sum", [
      makeEvent("prj_sum", "01JBQ90000000000000000000A", at, { fingerprint: "a" }),
      makeEvent("prj_sum", "01JBQ90000000000000000000B", at, { fingerprint: "a" }),
      makeEvent("prj_sum", "01JBQ90000000000000000000C", at, { fingerprint: "b" }),
    ]);
    const summary = await store.summarizeFingerprints("prj_sum");
    expect(Object.fromEntries(summary.map((s) => [s.fingerprint, s.eventCount]))).toEqual({ a: 2, b: 1 });
    expect(await store.summarizeFingerprints("prj_sum", ["b"])).toHaveLength(1);
  });

  it("rejects archiveDay until object storage exists", async () => {
    await expect(store.archiveDay("prj_rt", "2026-11-05")).rejects.toThrow(/Phase 2/);
  });

  describe("metadata", () => {
    it("creates the first admin once, and enforces membership", async () => {
      const admin = await meta.createFirstAdmin({ email: "Admin@Example.test", passwordHash: "$argon2id$synthetic" });
      expect(admin?.instanceRole).toBe("admin");
      expect(await meta.createFirstAdmin({ email: "second@example.test", passwordHash: "x" })).toBeNull();
      expect((await meta.findUserForLogin("admin@example.test"))?.user.id).toBe(admin!.id);

      const project = await meta.createProject(
        { userId: admin!.id, instanceRole: "admin" },
        { id: "prj_meta", name: "Meta", retentionDays: 30 },
      );
      expect(project.retentionDays).toBe(30);
      const access = await meta.resolveProjectAccess({ userId: admin!.id, instanceRole: "member" }, "prj_meta");
      expect(access?.viaInstanceAdmin).toBe(false);
      expect([...access!.permissions]).toContain("keys.manage");
      expect(
        await meta.resolveProjectAccess(
          { userId: "00000000-0000-0000-0000-000000000000", instanceRole: "member" },
          "prj_meta",
        ),
      ).toBeNull();
      expect(await meta.resolveProjectAccess({ userId: admin!.id, instanceRole: "admin" }, "prj_missing")).toBeNull();

      const key = await meta.createIngestionKey(access!, {
        keyId: "0123456789AB",
        keyHash: new Uint8Array(32).fill(7),
        name: "test",
      });
      expect(key.projectId).toBe("prj_meta");
      const lookup = await meta.findIngestionKey("0123456789AB");
      expect(lookup?.projectId).toBe("prj_meta");
      expect([...lookup!.keyHash]).toEqual(new Array(32).fill(7));
      const { rows } = await db.pool.query("SELECT action, target_id, details FROM audit_log ORDER BY id");
      expect(rows.map((r) => r.action)).toEqual(["user.created", "project.created", "ingestion_key.created"]);
      expect(JSON.stringify(rows)).not.toContain("argon2");
    });

    it("keeps issue counts derivable and never undoes newer upserts", async () => {
      const t0 = new Date(Date.now() - 1000);
      const user = await meta.findUserForLogin("admin@example.test");
      await meta.createProject(
        { userId: user!.user.id, instanceRole: "admin" },
        { id: "prj_issues", name: "Issues", retentionDays: 30 },
      );
      const summary = {
        fingerprint: "a",
        title: "t",
        kind: "log" as const,
        lastSeverity: "info" as const,
        eventCount: 3,
        firstSeen: t0,
        lastSeen: t0,
      };
      await meta.upsertIssues("prj_issues", [summary]);
      await meta.upsertIssues("prj_issues", [{ ...summary, eventCount: 2 }]);
      const count = async () =>
        (await db.pool.query("SELECT event_count FROM issues WHERE project_id = 'prj_issues'")).rows.map((r) =>
          Number(r.event_count),
        );
      expect(await count()).toEqual([3]);
      // A recount read before the last upsert must not overwrite it.
      await meta.replaceIssueCounts("prj_issues", [], new Date(Date.now() - 60_000));
      expect(await count()).toEqual([3]);
      await meta.replaceIssueCounts(
        "prj_issues",
        [{ fingerprint: "a", eventCount: 1, firstSeen: t0, lastSeen: t0 }],
        new Date(Date.now() + 60_000),
      );
      expect(await count()).toEqual([1]);
      await meta.replaceIssueCounts("prj_issues", [], new Date(Date.now() + 60_000));
      expect(await count()).toEqual([]);
    });
  });

  describe("queue", () => {
    it("delivers each job to one consumer with SKIP LOCKED", async () => {
      const q = new PostgresQueue<{ n: number }>(db.pool, "test-skip");
      for (let n = 0; n < 20; n++) await q.enqueue({ n });
      const batches = await Promise.all([q.dequeue(7), q.dequeue(7), q.dequeue(7), q.dequeue(7)]);
      const ids = batches.flat().map((j) => j.payload.n);
      expect(ids).toHaveLength(20);
      expect(new Set(ids).size).toBe(20);
      for (const j of batches.flat()) await q.ack(j);
      expect(await q.dequeue(10)).toHaveLength(0);
    });

    it("redelivers after the visibility timeout and ignores stale acks", async () => {
      const q = new PostgresQueue<string>(db.pool, "test-vis", { visibilityTimeoutMs: 200 });
      await q.enqueue("x");
      const [first] = await q.dequeue(1);
      expect(await q.dequeue(1)).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 300));
      const [second] = await q.dequeue(1);
      expect(second?.attempts).toBe(2);
      await q.ack(first!);
      const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM queue_jobs WHERE queue = 'test-vis'");
      expect(rows[0].n).toBe(1);
      await q.ack(second!);
    });

    it("retries with backoff, then dead-letters", async () => {
      const q = new PostgresQueue<string>(db.pool, "test-dead", { maxAttempts: 2, baseBackoffMs: 100 });
      await q.enqueue("x");
      const [a] = await q.dequeue(1);
      expect(await q.fail(a!, new Error("first"))).toBe("retry");
      expect(await q.dequeue(1)).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 150));
      const [b] = await q.dequeue(1);
      expect(b?.attempts).toBe(2);
      expect(await q.fail(b!, new Error("second"))).toBe("dead");
      const { rows } = await db.pool.query(
        "SELECT status, attempts, last_error FROM queue_jobs WHERE queue = 'test-dead'",
      );
      expect(rows[0]).toEqual({ status: "dead", attempts: 2, last_error: "Error: second" });
    });

    it("dead-letters a job whose final lease expires without an ack", async () => {
      const q = new PostgresQueue<string>(db.pool, "test-crash", { maxAttempts: 1, visibilityTimeoutMs: 100 });
      await q.enqueue("x");
      expect(await q.dequeue(1)).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 150));
      expect(await q.dequeue(1)).toHaveLength(0);
      const { rows } = await db.pool.query("SELECT status FROM queue_jobs WHERE queue = 'test-crash'");
      expect(rows[0].status).toBe("dead");
    });
  });
});

describe.skipIf(!hasDatabase)("PostgreSQL migrations", () => {
  it("run from an empty schema, then do nothing when run again", async () => {
    const db = await createTestDatabase({ migrate: false });
    try {
      const all = await loadMigrations();
      expect(await migrate(db.pool)).toEqual(all.map((m) => m.name));
      expect(await migrate(db.pool)).toEqual([]);
      expect(await runMigrations(db.pool)).toEqual([]);
      const { rows } = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations");
      expect(rows[0]?.n).toBe(all.length);
      const tables = await db.pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
        [db.schema],
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual(
        expect.arrayContaining(["projects", "queue_jobs", "project_daily_counters", "project_counter_increments"]),
      );
    } finally {
      await db.close();
    }
  });

  it("serialize concurrent runs", async () => {
    const db = await createTestDatabase({ migrate: false });
    try {
      const runs = await Promise.all([migrate(db.pool), migrate(db.pool), migrate(db.pool)]);
      expect(runs.flat()).toHaveLength((await loadMigrations()).length);
    } finally {
      await db.close();
    }
  });
});

describe.skipIf(!hasDatabase)("PostgreSQL counters, redaction rules, and queue bounds", () => {
  let db: TestDatabase;
  let meta: PostgresMetadataRepository;

  beforeAll(async () => {
    db = await createTestDatabase();
    meta = new PostgresMetadataRepository(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function adminAccess(projectId: string) {
    const admin =
      (await meta.createFirstAdmin({ email: "counters@example.test", passwordHash: "$argon2id$synthetic" })) ??
      (await meta.findUserForLogin("counters@example.test"))?.user;
    if (!admin) throw new Error("no admin");
    const actor = { userId: admin.id, instanceRole: "admin" as const };
    await meta.createProject(actor, { id: projectId, name: projectId, retentionDays: 30 });
    const access = await meta.resolveProjectAccess(actor, projectId);
    if (!access) throw new Error("no access");
    return access;
  }

  it("adds daily counters per project and day, once per idempotency key", async () => {
    const access = await adminAccess("prj_counters");
    const other = await adminAccess("prj_counters_other");
    expect(await meta.incrementDailyCounters("prj_counters", { day: "2026-11-05", accepted: 3, rejected: 1 })).toBe(
      true,
    );
    expect(await meta.incrementDailyCounters("prj_counters", { day: "2026-11-05", accepted: 2, sampled: 4 })).toBe(
      true,
    );
    const keyed = { day: "2026-11-06", accepted: 5, dropped: 2, idempotencyKey: "job:42" };
    const results = await Promise.all([
      meta.incrementDailyCounters("prj_counters", keyed),
      meta.incrementDailyCounters("prj_counters", keyed),
    ]);
    expect(results.sort()).toEqual([false, true]);
    // The same key in another project is a different increment.
    expect(await meta.incrementDailyCounters("prj_counters_other", keyed)).toBe(true);

    expect(await meta.listDailyCounters(access, { from: "2026-11-01", to: "2026-11-30" })).toEqual([
      { day: "2026-11-05", accepted: 5, rejected: 1, dropped: 0, sampled: 4 },
      { day: "2026-11-06", accepted: 5, rejected: 0, dropped: 2, sampled: 0 },
    ]);
    expect(await meta.listDailyCounters(other, { from: "2026-11-06", to: "2026-11-06" })).toEqual([
      { day: "2026-11-06", accepted: 5, rejected: 0, dropped: 2, sampled: 0 },
    ]);
    await expect(meta.incrementDailyCounters("prj_counters", { day: "2026-13-01", accepted: 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(meta.incrementDailyCounters("prj_counters", { day: "2026-11-05", accepted: -1 })).rejects.toThrow(
      RangeError,
    );

    const pruned = await meta.pruneDailyCounters("2026-11-06", new Date(Date.now() + 60_000));
    expect(pruned).toEqual({ counters: 1, keys: 2 });
    expect((await meta.listDailyCounters(access, { from: "2026-11-01", to: "2026-11-30" })).map((c) => c.day)).toEqual([
      "2026-11-06",
    ]);
  });

  it("stores normalized redaction rules and audits only their size", async () => {
    const access = await adminAccess("prj_redact");
    expect(await meta.getRedactionRules("prj_redact")).toEqual({ keys: [], patterns: [] });
    const stored = await meta.setRedactionRules(access, {
      keys: ["X-Internal-Token", "x_internal_token", "account number"],
      patterns: ["^card_.*$"],
    });
    expect(stored).toEqual({ keys: ["xinternaltoken", "accountnumber"], patterns: ["^card_.*$"] });
    expect(await meta.getRedactionRules("prj_redact")).toEqual(stored);
    expect(await meta.getRedactionRules("prj_missing")).toBeNull();
    await expect(meta.setRedactionRules(access, { keys: [], patterns: ["("] })).rejects.toThrow(RangeError);
    const { rows } = await db.pool.query(
      "SELECT details FROM audit_log WHERE action = 'project.redaction_rules_updated' AND project_id = 'prj_redact'",
    );
    expect(rows.map((r) => r.details)).toEqual([{ keys: 2, patterns: 1 }]);
  });

  it("reports depth, oldest age, and dead-lettered jobs", async () => {
    const q = new PostgresQueue<string>(db.pool, "test-stats", { maxAttempts: 1 });
    expect(await q.stats()).toEqual({ pending: 0, running: 0, depth: 0, dead: 0, oldestAgeMs: null });
    await q.enqueue("a");
    await q.enqueue("b");
    await q.enqueue("c");
    await new Promise((r) => setTimeout(r, 50));
    const [claimed] = await q.dequeue(1);
    expect(await q.fail(claimed!, new Error("poison"))).toBe("dead");
    await q.dequeue(1);
    const stats = await q.stats();
    expect(stats).toMatchObject({ pending: 1, running: 1, depth: 2, dead: 1 });
    expect(stats.oldestAgeMs).toBeGreaterThanOrEqual(40);
  });

  it("refuses to enqueue past the depth bound, not counting dead jobs", async () => {
    const q = new PostgresQueue<string>(db.pool, "test-bound", { maxDepth: 2, maxAttempts: 1 });
    await q.enqueue("a");
    await q.enqueue("b");
    await expect(q.enqueue("c")).rejects.toBeInstanceOf(QueueFullError);
    const [job] = await q.dequeue(1);
    await q.fail(job!, new Error("poison"));
    await q.enqueue("c");
    await expect(q.enqueue("d")).rejects.toBeInstanceOf(QueueFullError);
    expect(await q.stats()).toMatchObject({ depth: 2, dead: 1 });
    const { rows } = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM queue_jobs WHERE queue = 'test-bound'",
    );
    expect(rows[0]?.n).toBe(3);
  });
});
