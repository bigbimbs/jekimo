/**
 * Stopping or crashing the worker in the middle of a batch: a graceful stop
 * finishes every claimed job, and after a crash the unacknowledged jobs are
 * redelivered and reprocessed without duplicate events or double counts.
 */

import type { EventEnvelope } from "@jekimo/event-schema";
import type { IngestJob, Job, Queue } from "@jekimo/storage-postgres";
import { MemoryEventStore, MemoryMetadataRepository, MemoryQueue } from "@jekimo/storage-postgres/memory";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { Worker } from "../src/worker.js";

const IDS = ["01JBQ4Z3H8X9T2K7M5N6P8R9SV", "01JBQ50A6D2V8W4Y1Z3X5C7B9N", "01JBQ50A6D2V8W4Y1Z3X5C7B9P"];
const VISIBILITY_MS = 1_000;

let metadata: MemoryMetadataRepository;
let events: MemoryEventStore;
let now: number;
let queue: MemoryQueue<IngestJob>;

function job(eventId: string): IngestJob {
  const event: EventEnvelope = {
    schema_version: 1,
    event_id: eventId,
    timestamp: "2026-11-05T09:14:33.412Z",
    kind: "log",
    severity: "info",
    message: "order shipped",
  };
  return { project_id: "prj_test", key_id: "0123456789AB", received_at: "2026-11-05T09:15:00.000Z", events: [event] };
}

function worker(q: Queue<IngestJob> = queue) {
  return new Worker({
    queue: q,
    metadata,
    events,
    log: pino({ level: "silent" }),
    batchSize: 3,
    pollMs: 5,
    expiryIntervalMs: 60 * 60_000,
  });
}

const never = () => new Promise<never>(() => {});

beforeEach(async () => {
  metadata = new MemoryMetadataRepository();
  events = new MemoryEventStore();
  const user = metadata.addUser("owner@example.test", "hash", "member");
  await metadata.createProject(
    { userId: user.id, instanceRole: "member" },
    { id: "prj_test", name: "Test", retentionDays: 30 },
  );
  now = 0;
  queue = new MemoryQueue<IngestJob>({ visibilityTimeoutMs: VISIBILITY_MS }, () => now);
  for (const id of IDS) await queue.enqueue(job(id));
});

function expectProcessedOnce() {
  expect(queue.jobs).toHaveLength(0);
  expect(events.rows.map((r) => r.event.event_id).sort()).toEqual([...IDS].sort());
  expect(metadata.issues).toHaveLength(1);
  expect(metadata.issues[0]!.eventCount).toBe(3);
  expect(metadata.counters.get("prj_test")?.get("2026-11-05")).toMatchObject({ accepted: 3, dropped: 0, sampled: 0 });
}

describe("stopping in the middle of a batch", () => {
  it("finishes every claimed job before stop() resolves", async () => {
    let entered!: () => void;
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const append = events.appendEvents.bind(events);
    events.appendEvents = async (projectId, batch) => {
      if (batch[0]?.event.event_id === IDS[1]) {
        entered();
        await gate;
      }
      return append(projectId, batch);
    };

    const w = worker();
    w.start();
    await reached; // the second of three claimed jobs is in flight
    let stopped = false;
    const stopping = w.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expectProcessedOnce();
  });
});

describe("crashing in the middle of a batch", () => {
  it.each([
    ["after the event store append", "upsertIssues"],
    ["after the issue update", "incrementDailyCounters"],
    ["after the counters step", "ack"],
  ] as const)("redelivers unfinished jobs when the process dies %s", async (_point, hangIn) => {
    // Worker A dies while handling the second job: the call hangs forever and
    // nothing after it runs, as if the process had been killed.
    let crashed = false;
    const crashOn = (eventId: string | undefined) => {
      if (!crashed && eventId === IDS[1]) {
        crashed = true;
        return true;
      }
      return false;
    };
    const ack = queue.ack.bind(queue);
    const queueA: Queue<IngestJob> = {
      enqueue: (p) => queue.enqueue(p),
      dequeue: (n) => queue.dequeue(n),
      fail: (j, e) => queue.fail(j, e),
      stats: () => queue.stats(),
      ack: (j: Job<IngestJob>) => (hangIn === "ack" && crashOn(j.payload.events[0]?.event_id) ? never() : ack(j)),
    };
    if (hangIn !== "ack") {
      const original = metadata[hangIn].bind(metadata) as (...a: unknown[]) => Promise<unknown>;
      (metadata as unknown as Record<string, unknown>)[hangIn] = (projectId: string, arg: unknown) => {
        const eventId =
          hangIn === "upsertIssues"
            ? events.rows.at(-1)?.event.event_id // the append just stored this job's event
            : (arg as { idempotencyKey?: string }).idempotencyKey === "job:2"
              ? IDS[1]
              : undefined;
        return crashOn(eventId) ? never() : original(projectId, arg);
      };
    }

    void worker(queueA).drainOnce(); // never settles
    await new Promise((r) => setTimeout(r, 20));
    expect(crashed).toBe(true);
    // Job 1 is done and acknowledged; jobs 2 and 3 are still claimed.
    expect(queue.jobs.map((j) => [j.id, j.status])).toEqual([
      ["2", "running"],
      ["3", "running"],
    ]);
    expect(await worker().drainOnce()).toBe(0); // hidden until the timeout

    now += VISIBILITY_MS;
    expect(await worker().drainOnce()).toBe(2);
    expectProcessedOnce();
  });
});
