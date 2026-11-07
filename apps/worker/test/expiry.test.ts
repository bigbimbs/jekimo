/**
 * The expiry pass and disk safety (docs/retention.md, "Project retention
 * period", "Expiry mechanics", and "Disk safety"), with in-memory storage and
 * a fake disk probe.
 */

import type { EventEnvelope } from "@jekimo/event-schema";
import { DiskMonitor, type IngestJob } from "@jekimo/storage-postgres";
import { MemoryEventStore, MemoryMetadataRepository, MemoryQueue } from "@jekimo/storage-postgres/memory";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { processIngestJob, projectRetentionDays, runExpiryPass } from "../src/process.js";
import { Worker } from "../src/worker.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-05T12:00:00.000Z");
let metadata: MemoryMetadataRepository;
let events: MemoryEventStore;
let jobSeq = 0;
let eventSeq = 0;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ev(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  let suffix = "";
  for (let v = eventSeq++, i = 0; i < 6; i++, v = Math.floor(v / 32)) suffix = CROCKFORD[v % 32] + suffix;
  return {
    schema_version: 1,
    event_id: `01JBQ4Z3H8X9T2K7M5N6${suffix}`,
    timestamp: "2026-11-05T09:14:33.412Z",
    kind: "log",
    severity: "info",
    message: "order 1001 shipped",
    ...overrides,
  };
}

/** Stores `count` events received `daysAgo` days before NOW. */
async function receive(projectId: string, daysAgo: number, count = 1, message = "order 1001 shipped") {
  const receivedAt = new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
  const job: IngestJob = {
    project_id: projectId,
    key_id: "0123456789AB",
    received_at: receivedAt,
    events: Array.from({ length: count }, () => ev({ timestamp: receivedAt, message })),
  };
  await processIngestJob(job, { metadata, events }, { jobId: String(++jobSeq) });
}

function countFor(projectId: string): number {
  return events.rows.filter((r) => r.projectId === projectId).length;
}

beforeEach(async () => {
  metadata = new MemoryMetadataRepository();
  events = new MemoryEventStore();
  const user = metadata.addUser("owner@example.test", "hash", "member");
  for (const id of ["prj_a", "prj_b"]) {
    await metadata.createProject({ userId: user.id, instanceRole: "member" }, { id, name: id, retentionDays: 30 });
  }
});

describe("projectRetentionDays", () => {
  it("uses the stored period, the default for an invalid one, and never more than the maximum", () => {
    expect(projectRetentionDays(30)).toBe(30);
    expect(projectRetentionDays(0, 14)).toBe(14);
    expect(projectRetentionDays(4000, 14)).toBe(14);
    expect(projectRetentionDays(90, 30, 60)).toBe(60);
  });
});

describe("runExpiryPass", () => {
  it("expires whole received days per project past each project's retention", async () => {
    metadata.projects[1]!.retentionDays = 7;
    await receive("prj_a", 31, 2);
    await receive("prj_a", 10);
    await receive("prj_b", 10);
    await receive("prj_b", 2);

    const result = await runExpiryPass({ metadata, events }, NOW);
    expect(result.deletedEvents).toBe(3);
    expect(result.perProject).toEqual([
      { projectId: "prj_a", deleted: 2, retentionDays: 30 },
      { projectId: "prj_b", deleted: 1, retentionDays: 7 },
    ]);
    expect(countFor("prj_a")).toBe(1);
    expect(countFor("prj_b")).toBe(1);
    // A second pass finds nothing more to do.
    expect((await runExpiryPass({ metadata, events }, NOW)).deletedEvents).toBe(0);
  });

  it("bounds retention by JEKIMO_RETENTION_MAX_DAYS", async () => {
    metadata.projects[0]!.retentionDays = 365;
    await receive("prj_a", 40);
    expect((await runExpiryPass({ metadata, events }, NOW)).deletedEvents).toBe(0);
    const result = await runExpiryPass({ metadata, events }, NOW, undefined, { retentionMaxDays: 30 });
    expect(result.perProject).toEqual([{ projectId: "prj_a", deleted: 1, retentionDays: 30 }]);
  });

  it("expires the oldest days first", async () => {
    await receive("prj_a", 40);
    await receive("prj_b", 35);
    await receive("prj_a", 33);
    const calls: string[] = [];
    const expire = events.expireDay.bind(events);
    events.expireDay = async (projectId, day) => {
      calls.push(day);
      return expire(projectId, day);
    };
    await runExpiryPass({ metadata, events }, NOW);
    expect(calls).toEqual([...calls].sort());
  });

  it("converges after a pass interrupted while expiring days", async () => {
    await receive("prj_a", 40, 1, "only old");
    await receive("prj_a", 35);
    await receive("prj_a", 1);
    const expire = events.expireDay.bind(events);
    let calls = 0;
    events.expireDay = async (projectId, day) => {
      if (++calls === 2) throw new Error("connection lost");
      return expire(projectId, day);
    };
    await expect(runExpiryPass({ metadata, events }, NOW)).rejects.toThrow("connection lost");
    expect(countFor("prj_a")).toBe(2);

    events.expireDay = expire;
    const result = await runExpiryPass({ metadata, events }, NOW, undefined, { recountAll: true });
    expect(result.deletedEvents).toBe(1);
    expect(countFor("prj_a")).toBe(1);
    expect(metadata.issues.map((i) => [i.title, i.eventCount])).toEqual([["order 1001 shipped", 1]]);
  });

  it("recounts issues after a pass interrupted between expiry and recount", async () => {
    await receive("prj_a", 40, 1, "only old");
    await receive("prj_a", 1);
    const replace = metadata.replaceIssueCounts.bind(metadata);
    metadata.replaceIssueCounts = async () => {
      throw new Error("metadata down");
    };
    await expect(runExpiryPass({ metadata, events }, NOW)).rejects.toThrow("metadata down");
    metadata.replaceIssueCounts = replace;
    // The events are gone, so a plain pass deletes nothing and would not recount.
    expect((await runExpiryPass({ metadata, events }, NOW)).deletedEvents).toBe(0);
    expect(metadata.issues).toHaveLength(2);
    await runExpiryPass({ metadata, events }, NOW, undefined, { recountAll: true });
    expect(metadata.issues.map((i) => i.title)).toEqual(["order 1001 shipped"]);
  });

  it("cuts every project's retention to 7 days in an emergency", async () => {
    metadata.projects[1]!.retentionDays = 3;
    await receive("prj_a", 10, 2);
    await receive("prj_a", 5);
    await receive("prj_b", 5);
    expect((await runExpiryPass({ metadata, events }, NOW)).perProject).toEqual([
      { projectId: "prj_b", deleted: 1, retentionDays: 3 },
    ]);
    const result = await runExpiryPass({ metadata, events }, NOW, undefined, { emergency: true });
    expect(result.perProject).toEqual([{ projectId: "prj_a", deleted: 2, retentionDays: 7 }]);
    expect(countFor("prj_a")).toBe(1);
  });
});

describe("Worker disk safety", () => {
  let free: number | Error;
  let now: number;
  let logs: Record<string, unknown>[];
  let worker: Worker;

  beforeEach(() => {
    free = 50;
    now = NOW.getTime();
    logs = [];
    const log = pino({ level: "info" }, { write: (line: string) => logs.push(JSON.parse(line)) });
    worker = new Worker({
      queue: new MemoryQueue<IngestJob>(),
      metadata,
      events,
      log,
      batchSize: 10,
      pollMs: 10,
      expiryIntervalMs: 15 * 60_000,
      clock: () => new Date(now),
      disk: new DiskMonitor({
        probe: async () => {
          if (free instanceof Error) throw free;
          return free;
        },
        cacheMs: 0,
        clock: () => new Date(now),
      }),
    });
  });

  /** One loop iteration's maintenance, a minute after the last. */
  async function tick(minutes = 1) {
    now += minutes * 60_000;
    await worker.checkDiskIfDue();
    await worker.expireIfDue();
  }

  const messages = (msg: string) => logs.filter((l) => l.msg === msg);
  const auditLevels = () => metadata.audit.filter((a) => a.action === "instance.disk_level_changed");

  it("does nothing special while the disk is ok", async () => {
    await tick();
    expect(worker.emergency).toBe(false);
    expect(auditLevels()).toHaveLength(0);
    expect(messages("expiry pass done")).toHaveLength(1);
    await tick();
    // The normal interval is 15 minutes.
    expect(messages("expiry pass done")).toHaveLength(1);
  });

  it("warns and leaves an audit entry at the warning level, without emergency expiry", async () => {
    free = 15;
    await tick();
    expect(worker.emergency).toBe(false);
    expect(auditLevels()).toEqual([
      expect.objectContaining({ details: { level: "warn", previous: null, free_percent: 15 } }),
    ]);
    expect(messages("disk level changed")[0]).toMatchObject({ level: 40, disk_level: "warn", free_percent: 15 });
  });

  it.each([
    ["critical", 8],
    ["full", 3],
  ])("runs emergency expiry every minute at the %s level and logs it per project", async (level, percent) => {
    await receive("prj_a", 10, 2);
    await receive("prj_b", 9);
    await receive("prj_b", 1);
    await tick();
    expect(countFor("prj_a")).toBe(2);

    free = percent;
    await tick();
    expect(worker.emergency).toBe(true);
    expect(auditLevels().at(-1)).toMatchObject({ details: { level, previous: "ok" } });
    expect(countFor("prj_a")).toBe(0);
    expect(countFor("prj_b")).toBe(1);
    expect(messages("emergency expiry removed events")).toEqual([
      expect.objectContaining({ project_id: "prj_a", deleted_events: 2, retention_days: 7 }),
      expect.objectContaining({ project_id: "prj_b", deleted_events: 1, retention_days: 7 }),
    ]);
    const passes = messages("expiry pass done").length;
    await tick();
    expect(messages("expiry pass done")).toHaveLength(passes + 1);
    expect(messages("expiry pass done").at(-1)).toMatchObject({ emergency: true });
  });

  it("stays in emergency until free space is back above the warning level", async () => {
    free = 8;
    await tick();
    expect(worker.emergency).toBe(true);
    free = 15;
    await tick();
    expect(worker.emergency).toBe(true);
    free = 25;
    await tick();
    expect(worker.emergency).toBe(false);
    expect(auditLevels().map((a) => a.details?.level)).toEqual(["critical", "warn", "ok"]);
  });

  it("does not delete data early when free space cannot be read", async () => {
    await receive("prj_a", 10);
    free = new Error("statfs failed");
    await tick();
    await tick();
    expect(worker.emergency).toBe(false);
    expect(countFor("prj_a")).toBe(1);
    expect(auditLevels()).toHaveLength(0);
  });

  it("recounts every project after a failed pass", async () => {
    await receive("prj_a", 40, 1, "only old");
    await receive("prj_a", 1);
    const replace = metadata.replaceIssueCounts.bind(metadata);
    metadata.replaceIssueCounts = async () => {
      throw new Error("metadata down");
    };
    await tick();
    expect(messages("expiry pass failed")).toHaveLength(1);
    metadata.replaceIssueCounts = replace;
    await tick(15);
    expect(metadata.issues.map((i) => i.title)).toEqual(["order 1001 shipped"]);
  });
});
