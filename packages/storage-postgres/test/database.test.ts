import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppendEvent, EventStore } from "../src/index.js";
import { PostgresEventStore } from "../src/index.js";
import { MemoryEventStore } from "../src/memory/index.js";
import { createTestDatabase, hasDatabase, type TestDatabase } from "../src/testing.js";

const from = new Date("2026-11-15T00:00:00Z"),
  to = new Date("2026-11-16T00:00:00Z");
function record(n: number, project = "db_one", duration = 100): AppendEvent {
  return {
    receivedAt: new Date(from.getTime() + n * 1000),
    keyId: "synthetic",
    event: {
      schema_version: 1,
      event_id: `01JBQ4Z3H8X9T2K7M5N6P8R${String(n).padStart(3, "0")}`,
      timestamp: from.toISOString(),
      kind: "event",
      severity: "info",
      message: "invoices.list",
      project_id: project,
      fingerprint: "same-as-normal",
      environment: "production",
      context: { trace_id: (n === 2 ? "b" : "a").repeat(32) },
      database: {
        name: "invoices.list",
        system: "postgresql",
        operation: "select",
        status: n === 2 ? "error" : "ok",
        duration_ms: duration,
      },
    },
  };
}
for (const backend of ["memory", "postgres"] as const)
  describe.skipIf(backend === "postgres" && !hasDatabase)(`database metrics ${backend}`, () => {
    let db: TestDatabase | undefined;
    let store: EventStore;
    beforeAll(async () => {
      if (backend === "postgres") {
        db = await createTestDatabase();
        store = new PostgresEventStore(db.pool);
      } else store = new MemoryEventStore();
      const first = record(1);
      await store.appendEvents("db_one", [first, record(2, "db_one", 300), record(3, "db_one", 500)]);
      await store.appendEvents("db_one", [first]);
      await store.appendEvents("db_two", [record(1, "db_two", 10000)]);
      const normal = record(4);
      delete normal.event.database;
      await store.appendEvents("db_one", [normal]);
    });
    afterAll(async () => {
      await db?.close();
    });
    it("isolates projects and computes deduplicated percentiles and thresholds", async () => {
      const result = await store.summarizeDatabase("db_one", { from, to, slowMs: 300 });
      expect(result.totals).toEqual({ count: 3, errors: 1, slow: 2, averageMs: 300, p95Ms: 480, totalMs: 900 });
      expect(result.groups).toHaveLength(1);
      expect((await store.summarizeDatabase("missing", { from, to, slowMs: 300 })).totals.count).toBe(0);
      expect(
        (await store.summarizeDatabase("db_one", { from, to: new Date(from.getTime() + 2000), slowMs: 300 })).totals
          .count,
      ).toBe(1);
      expect(
        (await store.summarizeDatabase("db_one", { from, to, slowMs: 300, environment: "staging" })).totals.count,
      ).toBe(0);
    });
    it("round-trips query metadata through reads and exports while excluding issue counts", async () => {
      const page = await store.queryEvents("db_one", { from, to, limit: 2, database: true });
      expect(page.events).toHaveLength(2);
      expect(page.nextCursor).toBeDefined();
      const next = await store.queryEvents("db_one", { from, to, limit: 2, database: true, cursor: page.nextCursor! });
      expect(next.events).toHaveLength(1);
      expect((await store.queryEvents("db_one", { from, to, limit: 10, database: false })).events).toHaveLength(1);
      expect((await store.getEvent("db_one", record(1).event.event_id))?.event.database?.duration_ms).toBe(100);
      const exported = [];
      for await (const r of store.streamEvents("db_one", { from, to })) exported.push(r);
      expect(exported.filter((r) => r.event.database)).toHaveLength(3);
      expect(await store.summarizeFingerprints("db_one")).toEqual([expect.objectContaining({ eventCount: 1 })]);
    });
    it("filters traces across kinds with stable pagination and project isolation", async () => {
      const query = { from, to, limit: 1, traceId: "a".repeat(32) };
      const first = await store.queryEvents("db_one", query);
      expect(first.events).toHaveLength(1);
      expect(first.events[0]?.event.event_id).toBe(record(4).event.event_id);
      const next = await store.queryEvents("db_one", { ...query, cursor: first.nextCursor! });
      expect(next.events[0]?.event.event_id).toBe(record(3).event.event_id);
      const all = await store.queryEvents("db_one", { ...query, limit: 100 });
      expect(all.events).toHaveLength(3);
      expect(all.events.every((r) => r.event.project_id === "db_one")).toBe(true);
      expect((await store.queryEvents("db_one", { ...query, traceId: "c".repeat(32) })).events).toHaveLength(0);
    });
    it("stores timing context while excluding spans from rebuilt issue counts", async () => {
      const span = record(10, "span_project");
      delete span.event.database;
      span.event.fingerprint = "jekimo.span:1111111111111111";
      span.event.context = { trace_id: "a".repeat(32), span_type: "span", span_duration_ms: "50" };
      await store.appendEvents("span_project", [span]);
      expect(await store.summarizeFingerprints("span_project")).toEqual([]);
      expect((await store.getEvent("span_project", span.event.event_id))?.event.context).toEqual(span.event.context);
    });
  });
