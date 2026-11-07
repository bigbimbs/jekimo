/**
 * The worker against a real PostgreSQL. Skipped unless JEKIMO_DATABASE_URL
 * (or the deprecated DATABASE_URL) is set.
 */

import type { EventEnvelope } from "@jekimo/event-schema";
import {
  type IngestJob,
  PostgresEventStore,
  PostgresMetadataRepository,
  PostgresQueue,
  type ProjectAccess,
  runMigrations,
} from "@jekimo/storage-postgres";
import { createTestDatabase, hasDatabase, type TestDatabase } from "@jekimo/storage-postgres/testing";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "../src/worker.js";

const IDS = ["01JBQ4Z3H8X9T2K7M5N6P8R9SV", "01JBQ50A6D2V8W4Y1Z3X5C7B9N", "01JBQ50A6D2V8W4Y1Z3X5C7B9P"];

describe.skipIf(!hasDatabase)("worker on PostgreSQL", () => {
  let db: TestDatabase;
  let access: ProjectAccess;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool); // creates this week's event partitions
    const meta = new PostgresMetadataRepository(db.pool);
    const admin = await meta.createFirstAdmin({ email: "worker@example.test", passwordHash: "$argon2id$synthetic" });
    if (!admin) throw new Error("no admin");
    const actor = { userId: admin.id, instanceRole: "admin" as const };
    await meta.createProject(actor, { id: "prj_worker", name: "Worker", retentionDays: 30 });
    const resolved = await meta.resolveProjectAccess(actor, "prj_worker");
    if (!resolved) throw new Error("no access");
    access = resolved;
    await meta.setRedactionRules(access, { keys: ["customer_id"], patterns: ["^x-internal-"] });
  });

  afterAll(async () => {
    await db?.close();
  });

  function worker(queue: PostgresQueue<IngestJob>, metadata = new PostgresMetadataRepository(db.pool)) {
    return new Worker({
      queue,
      metadata,
      events: new PostgresEventStore(db.pool),
      log: pino({ level: "silent" }),
      batchSize: 3,
      pollMs: 10,
      expiryIntervalMs: 60 * 60_000,
    });
  }

  it("reprocesses a batch after a crash mid-batch with no duplicates or double counts, redacting and validating", async () => {
    const receivedAt = new Date();
    const queue = new PostgresQueue<IngestJob>(db.pool, "ingest-crash", { visibilityTimeoutMs: 300 });
    for (const id of IDS) {
      const event: EventEnvelope = {
        schema_version: 1,
        event_id: id,
        timestamp: receivedAt.toISOString(),
        kind: "log",
        severity: "info",
        message: "order shipped",
        context: { customerId: "c_1", "x-internal-trace": "t_1", route: "/orders" },
      };
      await queue.enqueue({
        project_id: "prj_worker",
        key_id: "0123456789AB",
        received_at: receivedAt.toISOString(),
        // The third job carries an event that fails stored validation.
        events:
          id === IDS[2]
            ? [event, { ...event, event_id: "01JBQ50A6D2V8W4Y1Z3X5C7B9Q", kind: "nope" as "log" }]
            : [event],
      });
    }

    // Worker A dies after counting the second job, before acknowledging it.
    const crashing = new PostgresMetadataRepository(db.pool);
    const increment = crashing.incrementDailyCounters.bind(crashing);
    let calls = 0;
    crashing.incrementDailyCounters = async (projectId, input) => {
      const applied = await increment(projectId, input);
      if (++calls === 2) await new Promise<never>(() => {});
      return applied;
    };
    void worker(queue, crashing).drainOnce();
    await expect.poll(() => calls).toBe(2);
    expect((await queue.stats()).running).toBe(2);

    await new Promise((r) => setTimeout(r, 400)); // past the visibility timeout
    const b = worker(queue);
    while ((await b.drainOnce()) > 0) {}
    expect((await queue.stats()).depth).toBe(0);

    const events = new PostgresEventStore(db.pool);
    const page = await events.queryEvents("prj_worker", {
      from: new Date(receivedAt.getTime() - 60_000),
      to: new Date(receivedAt.getTime() + 60_000),
      limit: 10,
    });
    expect(page.events.map((e) => e.event.event_id).sort()).toEqual([...IDS].sort());
    expect(page.events[0]!.event.context).toEqual({
      customerId: "[REDACTED]",
      "x-internal-trace": "[REDACTED]",
      route: "/orders",
    });
    // Issue counts derive from the event store; one fingerprint, three events.
    expect((await events.summarizeFingerprints("prj_worker")).map((s) => s.eventCount)).toEqual([3]);
    const day = receivedAt.toISOString().slice(0, 10);
    expect(await new PostgresMetadataRepository(db.pool).listDailyCounters(access, { from: day, to: day })).toEqual([
      { day, accepted: 3, rejected: 0, dropped: 1, sampled: 0 },
    ]);
  });
});
