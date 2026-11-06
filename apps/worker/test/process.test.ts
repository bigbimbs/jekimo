import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "@jekimo/event-schema";
import type { IngestJob } from "@jekimo/storage-postgres";
import { MemoryEventStore, MemoryMetadataRepository, MemoryQueue } from "@jekimo/storage-postgres/memory";
import { processIngestJob, runExpiryPass } from "../src/process.js";
import { Worker } from "../src/worker.js";

const DAY_MS = 24 * 60 * 60 * 1000;
let metadata: MemoryMetadataRepository;
let events: MemoryEventStore;

function ev(eventId: string, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return { schema_version: 1, event_id: eventId, timestamp: "2026-11-05T09:14:33.412Z", kind: "log", severity: "info", message: "order 1001 shipped", ...overrides };
}

function job(evs: EventEnvelope[], receivedAt = "2026-11-05T09:15:00.000Z"): IngestJob {
  return { project_id: "prj_test", key_id: "0123456789AB", received_at: receivedAt, skew_ms: 1000, events: evs };
}

beforeEach(async () => {
  metadata = new MemoryMetadataRepository();
  events = new MemoryEventStore();
  const user = metadata.addUser("owner@example.test", "hash", "member");
  await metadata.createProject({ userId: user.id, instanceRole: "member" }, { id: "prj_test", name: "Test", retentionDays: 30 });
});

describe("processIngestJob", () => {
  it("stores events with server metadata and a derived fingerprint, and summarises issues", async () => {
    const result = await processIngestJob(job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV"), ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N", { message: "order 2002 shipped" })]), { metadata, events });
    expect(result).toEqual({ projectFound: true, received: 2, sampledOut: 0, inserted: 2 });
    const stored = events.rows[0]!;
    expect(stored.event.project_id).toBe("prj_test");
    expect(stored.keyId).toBe("0123456789AB");
    expect(stored.skewMs).toBe(1000);
    expect(stored.receivedAt.toISOString()).toBe("2026-11-05T09:15:00.000Z");
    expect(stored.event.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.issues).toHaveLength(1);
    expect(metadata.issues[0]).toMatchObject({ eventCount: 2, title: "order 1001 shipped".replace("1001", "2002"), lastSeverity: "info" });
  });

  it("is idempotent when a job is processed twice", async () => {
    const j = job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV"), ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N")]);
    await processIngestJob(j, { metadata, events });
    const again = await processIngestJob(j, { metadata, events });
    expect(again.inserted).toBe(0);
    expect(events.rows).toHaveLength(2);
    expect(metadata.issues[0]!.eventCount).toBe(2);
  });

  it("repairs the issue summary on retry after the issue update failed", async () => {
    const j = job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")]);
    const upsert = metadata.upsertIssues.bind(metadata);
    metadata.upsertIssues = async () => {
      throw new Error("metadata down");
    };
    await expect(processIngestJob(j, { metadata, events })).rejects.toThrow("metadata down");
    expect(events.rows).toHaveLength(1);
    metadata.upsertIssues = upsert;
    await processIngestJob(j, { metadata, events });
    expect(metadata.issues[0]!.eventCount).toBe(1);
  });

  it("applies the project sample rate but never samples exceptions or errors", async () => {
    metadata.projects[0]!.sampleRate = 0;
    const result = await processIngestJob(
      job([
        ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV"),
        ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N", { severity: "error" }),
        ev("01JBQ50A6D2V8W4Y1Z3X5C7B9P", { kind: "exception", severity: "warning", exception: { type: "E" } }),
      ]),
      { metadata, events },
    );
    expect(result.sampledOut).toBe(1);
    expect(events.rows.map((r) => r.event.event_id)).toEqual(["01JBQ50A6D2V8W4Y1Z3X5C7B9N", "01JBQ50A6D2V8W4Y1Z3X5C7B9P"]);
  });

  it("redacts default sensitive keys server-side", async () => {
    await processIngestJob(job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV", { context: { request_id: "req_1", Authorization: "synthetic" }, attributes: { nested: { api_key: "synthetic" }, ok: 1 } })]), { metadata, events });
    const stored = events.rows[0]!.event;
    expect(stored.context).toEqual({ request_id: "req_1", Authorization: "[REDACTED]" });
    expect(stored.attributes).toEqual({ nested: { api_key: "[REDACTED]" }, ok: 1 });
  });

  it("drops jobs for projects that no longer exist", async () => {
    const result = await processIngestJob({ ...job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")]), project_id: "prj_gone" }, { metadata, events });
    expect(result.projectFound).toBe(false);
    expect(events.rows).toHaveLength(0);
  });
});

describe("runExpiryPass", () => {
  it("expires whole days past retention and recounts issues from the event store", async () => {
    const now = new Date("2026-11-05T12:00:00.000Z");
    const old = new Date(now.getTime() - 32 * DAY_MS).toISOString();
    const recent = new Date(now.getTime() - DAY_MS).toISOString();
    await processIngestJob(job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV", { message: "old only" })], old), { metadata, events });
    await processIngestJob(job([ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N")], old), { metadata, events });
    await processIngestJob(job([ev("01JBQ50A6D2V8W4Y1Z3X5C7B9P")], recent), { metadata, events });
    expect(metadata.issues.map((i) => i.eventCount).sort()).toEqual([1, 2]);

    const result = await runExpiryPass({ metadata, events }, now);
    expect(result.deletedEvents).toBe(2);
    expect(events.rows.map((r) => r.event.event_id)).toEqual(["01JBQ50A6D2V8W4Y1Z3X5C7B9P"]);
    expect(metadata.issues).toHaveLength(1);
    expect(metadata.issues[0]!.eventCount).toBe(1);
    expect(result.dedupePruned).toBe(2);
  });

  it("keeps a day until its last instant has passed retention", async () => {
    const received = "2026-10-06T23:59:59.000Z";
    await processIngestJob(job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")], received), { metadata, events });
    expect((await runExpiryPass({ metadata, events }, new Date("2026-11-05T12:00:00.000Z"))).deletedEvents).toBe(0);
    expect((await runExpiryPass({ metadata, events }, new Date("2026-11-06T00:00:00.000Z"))).deletedEvents).toBe(1);
  });
});

describe("Worker", () => {
  it("acks processed jobs and retries failures until they are dead-lettered", async () => {
    let now = 0;
    const queue = new MemoryQueue<IngestJob>({ maxAttempts: 2, baseBackoffMs: 10 }, () => now);
    const worker = new Worker({ queue, metadata, events, log: pino({ level: "silent" }), batchSize: 10, pollMs: 10, expiryIntervalMs: 60_000 });
    await queue.enqueue(job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")]));
    expect(await worker.drainOnce()).toBe(1);
    expect(queue.jobs).toHaveLength(0);
    expect(events.rows).toHaveLength(1);

    const append = events.appendEvents.bind(events);
    events.appendEvents = async () => {
      throw new Error("event store down");
    };
    await queue.enqueue(job([ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N")]));
    await worker.drainOnce();
    expect(queue.jobs[0]).toMatchObject({ status: "pending", lastError: "Error: event store down" });
    now = 10;
    await worker.drainOnce();
    expect(queue.jobs[0]!.status).toBe("dead");
    events.appendEvents = append;
  });

  it("starts and stops cleanly", async () => {
    const queue = new MemoryQueue<IngestJob>();
    const worker = new Worker({ queue, metadata, events, log: pino({ level: "silent" }), batchSize: 10, pollMs: 5, expiryIntervalMs: 60_000 });
    await queue.enqueue(job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")]));
    worker.start();
    await new Promise((r) => setTimeout(r, 30));
    await worker.stop();
    expect(events.rows).toHaveLength(1);
  });
});
