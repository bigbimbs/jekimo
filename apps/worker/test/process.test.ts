import type { EventEnvelope } from "@jekimo/event-schema";
import type { IngestJob } from "@jekimo/storage-postgres";
import { MemoryEventStore, MemoryMetadataRepository, MemoryQueue } from "@jekimo/storage-postgres/memory";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { counterRetentionStart, processIngestJob, runExpiryPass } from "../src/process.js";
import { RedactorCache } from "../src/redact.js";
import { Worker } from "../src/worker.js";

const DAY_MS = 24 * 60 * 60 * 1000;
let metadata: MemoryMetadataRepository;
let jobSeq = 0;
/** A fresh queue job id per call, as the queue would assign. */
const ctx = () => ({ jobId: String(++jobSeq) });
let events: MemoryEventStore;

function ev(eventId: string, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    schema_version: 1,
    event_id: eventId,
    timestamp: "2026-11-05T09:14:33.412Z",
    kind: "log",
    severity: "info",
    message: "order 1001 shipped",
    ...overrides,
  };
}

function job(evs: EventEnvelope[], receivedAt = "2026-11-05T09:15:00.000Z"): IngestJob {
  return { project_id: "prj_test", key_id: "0123456789AB", received_at: receivedAt, skew_ms: 1000, events: evs };
}

beforeEach(async () => {
  metadata = new MemoryMetadataRepository();
  events = new MemoryEventStore();
  const user = metadata.addUser("owner@example.test", "hash", "member");
  await metadata.createProject(
    { userId: user.id, instanceRole: "member" },
    { id: "prj_test", name: "Test", retentionDays: 30 },
  );
});

describe("processIngestJob", () => {
  it("stores events with server metadata and a derived fingerprint, and summarises issues", async () => {
    const result = await processIngestJob(
      job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV"), ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N", { message: "order 2002 shipped" })]),
      { metadata, events },
      ctx(),
    );
    expect(result).toEqual({ projectFound: true, received: 2, sampledOut: 0, dropped: [], inserted: 2 });
    const stored = events.rows[0]!;
    expect(stored.event.project_id).toBe("prj_test");
    expect(stored.keyId).toBe("0123456789AB");
    expect(stored.skewMs).toBe(1000);
    expect(stored.receivedAt.toISOString()).toBe("2026-11-05T09:15:00.000Z");
    expect(stored.event.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.issues).toHaveLength(1);
    expect(metadata.issues[0]).toMatchObject({
      eventCount: 2,
      title: "order 1001 shipped".replace("1001", "2002"),
      lastSeverity: "info",
    });
  });

  it("is idempotent when a job is processed twice", async () => {
    const j = job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV"), ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N")]);
    await processIngestJob(j, { metadata, events }, { jobId: "7" });
    const again = await processIngestJob(j, { metadata, events }, { jobId: "7" });
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
    await expect(processIngestJob(j, { metadata, events }, { jobId: "7" })).rejects.toThrow("metadata down");
    expect(events.rows).toHaveLength(1);
    metadata.upsertIssues = upsert;
    await processIngestJob(j, { metadata, events }, { jobId: "7" });
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
      ctx(),
    );
    expect(result.sampledOut).toBe(1);
    expect(events.rows.map((r) => r.event.event_id)).toEqual([
      "01JBQ50A6D2V8W4Y1Z3X5C7B9N",
      "01JBQ50A6D2V8W4Y1Z3X5C7B9P",
    ]);
  });

  it("redacts default sensitive keys server-side", async () => {
    await processIngestJob(
      job([
        ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV", {
          context: { request_id: "req_1", Authorization: "synthetic" },
          attributes: { nested: { api_key: "synthetic" }, ok: 1 },
        }),
      ]),
      { metadata, events },
      ctx(),
    );
    const stored = events.rows[0]!.event;
    expect(stored.context).toEqual({ request_id: "req_1", Authorization: "[REDACTED]" });
    expect(stored.attributes).toEqual({ nested: { api_key: "[REDACTED]" }, ok: 1 });
  });

  it("drops jobs for projects that no longer exist", async () => {
    const result = await processIngestJob(
      { ...job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")]), project_id: "prj_gone" },
      { metadata, events },
      ctx(),
    );
    expect(result.projectFound).toBe(false);
    expect(events.rows).toHaveLength(0);
  });
});

const counters = (day = "2026-11-05") => metadata.counters.get("prj_test")?.get(day);

describe("stored-form validation", () => {
  it("drops events that fail stored validation, keeps the rest, and reports no content", async () => {
    const bad = { ...ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N"), message: undefined } as unknown as EventEnvelope;
    const result = await processIngestJob(job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV"), bad]), { metadata, events }, ctx());
    expect(result.dropped).toEqual([
      { index: 1, eventId: "01JBQ50A6D2V8W4Y1Z3X5C7B9N", errors: [{ path: "/message", code: "required" }] },
    ]);
    expect(events.rows.map((r) => r.event.event_id)).toEqual(["01JBQ4Z3H8X9T2K7M5N6P8R9SV"]);
    expect(counters()).toMatchObject({ accepted: 1, dropped: 1, sampled: 0 });
  });

  it("checks future timestamps against the client's sent_at, as the API did", async () => {
    // Four minutes ahead of sent_at, which was 10 minutes behind received_at.
    const j = { ...job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV", { timestamp: "2026-11-05T09:09:00.000Z" })]) };
    j.skew_ms = 10 * 60_000;
    expect((await processIngestJob(j, { metadata, events }, ctx())).dropped).toEqual([]);
    const future = job([ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N", { timestamp: "2026-11-05T09:30:00.000Z" })]);
    expect((await processIngestJob(future, { metadata, events }, ctx())).dropped[0]?.errors[0]?.code).toBe(
      "future_timestamp",
    );
  });

  it("stores the canonical stored form without unknown fields", async () => {
    const extra = { ...ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV"), future_field: 1 } as EventEnvelope;
    await processIngestJob(job([extra]), { metadata, events }, ctx());
    expect(events.rows[0]!.event).not.toHaveProperty("future_field");
    expect(events.rows[0]!.event.project_id).toBe("prj_test");
  });
});

describe("project redaction rules", () => {
  it("applies operator keys and patterns on top of the default list", async () => {
    metadata.redactionRules.set("prj_test", { keys: ["customerid"], patterns: ["^x-internal-", "email$"] });
    await processIngestJob(
      job([
        ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV", {
          context: { "Customer-Id": "c_1", "x-internal-trace": "t_1", route: "/orders", password: "synthetic" },
          attributes: { user: { contact_email: "someone@example.test", plan: "free" }, items: [{ customer_id: 3 }] },
        }),
      ]),
      { metadata, events },
      ctx(),
    );
    const stored = events.rows[0]!.event;
    expect(stored.context).toEqual({
      "Customer-Id": "[REDACTED]",
      "x-internal-trace": "[REDACTED]",
      route: "/orders",
      password: "[REDACTED]",
    });
    expect(stored.attributes).toEqual({
      user: { contact_email: "[REDACTED]", plan: "free" },
      items: [{ customer_id: "[REDACTED]" }],
    });
  });

  it("matches patterns against the raw key, case-sensitively", async () => {
    metadata.redactionRules.set("prj_test", { keys: [], patterns: ["^Internal"] });
    await processIngestJob(
      job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV", { context: { InternalNote: "n", internal_note: "m" } })]),
      { metadata, events },
      ctx(),
    );
    expect(events.rows[0]!.event.context).toEqual({ InternalNote: "[REDACTED]", internal_note: "m" });
  });

  it("reads rules once per batch, so a change applies from the next batch", async () => {
    let reads = 0;
    const get = metadata.getRedactionRules.bind(metadata);
    metadata.getRedactionRules = (projectId) => {
      reads++;
      return get(projectId);
    };
    const batch = new RedactorCache(metadata);
    const deps = { metadata, events };
    await processIngestJob(job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")]), deps, { jobId: "1", redactors: batch });
    metadata.redactionRules.set("prj_test", { keys: ["route"], patterns: [] });
    await processIngestJob(job([ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N", { context: { route: "/a" } })]), deps, {
      jobId: "2",
      redactors: batch,
    });
    expect(reads).toBe(1);
    expect(events.rows[1]!.event.context).toEqual({ route: "/a" });
    await processIngestJob(job([ev("01JBQ50A6D2V8W4Y1Z3X5C7B9P", { context: { route: "/b" } })]), deps, {
      jobId: "3",
      redactors: new RedactorCache(metadata),
    });
    expect(reads).toBe(2);
    expect(events.rows[2]!.event.context).toEqual({ route: "[REDACTED]" });
  });

  it("fails the job instead of storing unredacted data when a stored pattern does not compile", async () => {
    metadata.redactionRules.set("prj_test", { keys: [], patterns: ["("] });
    await expect(
      processIngestJob(job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")]), { metadata, events }, ctx()),
    ).rejects.toThrow(SyntaxError);
    expect(events.rows).toHaveLength(0);
  });
});

describe("daily counters", () => {
  it("counts accepted, dropped, and sampled events on the UTC day of received_at", async () => {
    metadata.projects[0]!.sampleRate = 0;
    const bad = { ...ev("01JBQ50A6D2V8W4Y1Z3X5C7B9P", { severity: "error" }), message: 42 } as unknown as EventEnvelope;
    await processIngestJob(
      job(
        [ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV"), ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N", { severity: "error" }), bad],
        "2026-11-05T23:59:59.999Z",
      ),
      { metadata, events },
      ctx(),
    );
    expect(counters()).toEqual({ day: "2026-11-05", accepted: 1, rejected: 0, dropped: 1, sampled: 1 });
  });

  it("counts a redelivered job once, and repeats of earlier events as accepted", async () => {
    const j = job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")]);
    await processIngestJob(j, { metadata, events }, { jobId: "41" });
    await processIngestJob(j, { metadata, events }, { jobId: "41" });
    expect(counters()?.accepted).toBe(1);
    // The same event in a new request: acknowledged and counted, not stored.
    const repeat = await processIngestJob(j, { metadata, events }, { jobId: "42" });
    expect(repeat.inserted).toBe(0);
    expect(counters()?.accepted).toBe(2);
    expect(events.rows).toHaveLength(1);
  });

  it("increments counters after the event store append and the issue update", async () => {
    const order: string[] = [];
    const wrap = <T extends object, K extends keyof T>(target: T, name: K) => {
      const fn = (target[name] as (...a: unknown[]) => Promise<unknown>).bind(target);
      (target as Record<K, unknown>)[name] = async (...a: unknown[]) => {
        order.push(String(name));
        return fn(...a);
      };
    };
    wrap(events, "appendEvents");
    wrap(metadata, "upsertIssues");
    wrap(metadata, "incrementDailyCounters");
    await processIngestJob(job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")]), { metadata, events }, ctx());
    expect(order).toEqual(["appendEvents", "upsertIssues", "incrementDailyCounters"]);
  });

  it("counts on retry after the counters step failed, without duplicating events", async () => {
    const j = job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")]);
    const inc = metadata.incrementDailyCounters.bind(metadata);
    metadata.incrementDailyCounters = async () => {
      throw new Error("metadata down");
    };
    await expect(processIngestJob(j, { metadata, events }, { jobId: "9" })).rejects.toThrow("metadata down");
    metadata.incrementDailyCounters = inc;
    await processIngestJob(j, { metadata, events }, { jobId: "9" });
    expect(counters()?.accepted).toBe(1);
    expect(events.rows).toHaveLength(1);
    expect(metadata.issues[0]!.eventCount).toBe(1);
  });
});

describe("counterRetentionStart", () => {
  it.each([
    ["2026-11-05T12:00:00.000Z", "2025-10-05"],
    ["2026-01-15T00:00:00.000Z", "2024-12-15"],
    ["2026-03-31T23:59:59.000Z", "2025-02-28"],
    ["2025-03-31T00:00:00.000Z", "2024-02-29"],
  ])("keeps 13 months before %s from %s", (now, day) => {
    expect(counterRetentionStart(new Date(now))).toBe(day);
  });
});

describe("runExpiryPass", () => {
  it("expires whole days past retention and recounts issues from the event store", async () => {
    const now = new Date("2026-11-05T12:00:00.000Z");
    const old = new Date(now.getTime() - 32 * DAY_MS).toISOString();
    const recent = new Date(now.getTime() - DAY_MS).toISOString();
    await processIngestJob(
      job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV", { message: "old only", timestamp: old })], old),
      { metadata, events },
      ctx(),
    );
    await processIngestJob(
      job([ev("01JBQ50A6D2V8W4Y1Z3X5C7B9N", { timestamp: old })], old),
      { metadata, events },
      ctx(),
    );
    await processIngestJob(
      job([ev("01JBQ50A6D2V8W4Y1Z3X5C7B9P", { timestamp: recent })], recent),
      { metadata, events },
      ctx(),
    );
    expect(metadata.issues.map((i) => i.eventCount).sort()).toEqual([1, 2]);

    const result = await runExpiryPass({ metadata, events }, now);
    expect(result.deletedEvents).toBe(2);
    expect(events.rows.map((r) => r.event.event_id)).toEqual(["01JBQ50A6D2V8W4Y1Z3X5C7B9P"]);
    expect(metadata.issues).toHaveLength(1);
    expect(metadata.issues[0]!.eventCount).toBe(1);
    expect(result.dedupePruned).toBe(2);
  });

  it("drops daily counters older than 13 months", async () => {
    await metadata.incrementDailyCounters("prj_test", { day: "2025-10-04", accepted: 5 });
    await metadata.incrementDailyCounters("prj_test", { day: "2025-10-05", accepted: 6 });
    const result = await runExpiryPass({ metadata, events }, new Date("2026-11-05T12:00:00.000Z"));
    expect(result.countersPruned).toBe(1);
    expect([...(metadata.counters.get("prj_test")?.keys() ?? [])]).toEqual(["2025-10-05"]);
  });

  it("deletes audit entries older than the audit retention, including ones about deleted projects", async () => {
    const now = new Date("2026-11-05T12:00:00.000Z");
    metadata.audit.length = 0;
    metadata.audit.push(
      { action: "project.created", projectId: "prj_gone", occurredAt: new Date(now.getTime() - 400 * DAY_MS) },
      { action: "project.created", projectId: "prj_gone", occurredAt: new Date(now.getTime() - 20 * DAY_MS) },
      { action: "auth.login", occurredAt: new Date(now.getTime() - 5 * DAY_MS) },
    );
    expect((await runExpiryPass({ metadata, events }, now)).auditPruned).toBe(1);
    expect((await runExpiryPass({ metadata, events, auditLogDays: 10 }, now)).auditPruned).toBe(1);
    expect(metadata.audit.map((a) => a.action)).toEqual(["auth.login"]);
  });

  it("keeps a day until its last instant has passed retention", async () => {
    const received = "2026-10-06T23:59:59.000Z";
    await processIngestJob(
      job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV", { timestamp: received })], received),
      { metadata, events },
      ctx(),
    );
    expect((await runExpiryPass({ metadata, events }, new Date("2026-11-05T12:00:00.000Z"))).deletedEvents).toBe(0);
    expect((await runExpiryPass({ metadata, events }, new Date("2026-11-06T00:00:00.000Z"))).deletedEvents).toBe(1);
  });
});

describe("Worker", () => {
  it("acks processed jobs and retries failures until they are dead-lettered", async () => {
    let now = 0;
    const queue = new MemoryQueue<IngestJob>({ maxAttempts: 2, baseBackoffMs: 10 }, () => now);
    const worker = new Worker({
      queue,
      metadata,
      events,
      log: pino({ level: "silent" }),
      batchSize: 10,
      pollMs: 10,
      expiryIntervalMs: 60_000,
    });
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
    const worker = new Worker({
      queue,
      metadata,
      events,
      log: pino({ level: "silent" }),
      batchSize: 10,
      pollMs: 5,
      expiryIntervalMs: 60_000,
    });
    await queue.enqueue(job([ev("01JBQ4Z3H8X9T2K7M5N6P8R9SV")]));
    worker.start();
    await new Promise((r) => setTimeout(r, 30));
    await worker.stop();
    expect(events.rows).toHaveLength(1);
  });
});
