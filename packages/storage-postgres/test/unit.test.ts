import { describe, expect, it } from "vitest";
import { assertProjectAccess, mintProjectAccess, type ProjectAccess } from "../src/access.js";
import { decodeCursor, encodeCursor } from "../src/event-store.js";
import { DEFAULT_QUEUE_POLICY, daysFrom, decideFailure, partitionName } from "../src/index.js";
import { MemoryMetadataRepository, MemoryQueue } from "../src/memory/index.js";
import { describeError } from "../src/queue.js";

describe("queue retry policy", () => {
  it("backs off exponentially from the base delay up to the cap", () => {
    const policy = { baseBackoffMs: 1000, maxBackoffMs: 8000 };
    expect(decideFailure(1, 10, policy)).toEqual({ status: "retry", delayMs: 1000 });
    expect(decideFailure(2, 10, policy)).toEqual({ status: "retry", delayMs: 2000 });
    expect(decideFailure(3, 10, policy)).toEqual({ status: "retry", delayMs: 4000 });
    expect(decideFailure(5, 10, policy)).toEqual({ status: "retry", delayMs: 8000 });
  });

  it("dead-letters once the final attempt fails", () => {
    expect(decideFailure(5, 5, DEFAULT_QUEUE_POLICY)).toEqual({ status: "dead" });
    expect(decideFailure(6, 5, DEFAULT_QUEUE_POLICY)).toEqual({ status: "dead" });
  });

  it("records errors without payloads and bounded in length", () => {
    expect(describeError(new TypeError("boom"))).toBe("TypeError: boom");
    expect(describeError({ secret: "x" })).toBe("non-error thrown");
    expect(describeError(new Error("x".repeat(2000))).length).toBe(500);
  });
});

describe("memory queue semantics", () => {
  it("hides claimed jobs until the visibility timeout, then redelivers", async () => {
    let now = 0;
    const q = new MemoryQueue<string>({ visibilityTimeoutMs: 100 }, () => now);
    await q.enqueue("a");
    const [first] = await q.dequeue(10);
    expect(first?.attempts).toBe(1);
    expect(await q.dequeue(10)).toHaveLength(0);
    now = 100;
    const [again] = await q.dequeue(10);
    expect(again?.attempts).toBe(2);
    // The first consumer's lease is gone, so its ack does nothing.
    await q.ack(first!);
    expect(q.jobs).toHaveLength(1);
    await q.ack(again!);
    expect(q.jobs).toHaveLength(0);
  });

  it("retries with backoff and dead-letters after maxAttempts", async () => {
    let now = 0;
    const q = new MemoryQueue<string>({ maxAttempts: 2, baseBackoffMs: 50 }, () => now);
    await q.enqueue("a");
    const [j1] = await q.dequeue(1);
    expect(await q.fail(j1!, new Error("x"))).toBe("retry");
    expect(await q.dequeue(1)).toHaveLength(0);
    now = 50;
    const [j2] = await q.dequeue(1);
    expect(await q.fail(j2!, new Error("x"))).toBe("dead");
    now = 1_000_000;
    expect(await q.dequeue(1)).toHaveLength(0);
    expect(q.jobs[0]?.status).toBe("dead");
  });
});

describe("event partitions", () => {
  it("names one partition per UTC day", () => {
    expect(partitionName("2026-11-05")).toBe("events_20261105");
    expect(() => partitionName("2026-11-05; DROP TABLE events")).toThrow(RangeError);
  });

  it("lists consecutive UTC days", () => {
    expect(daysFrom(new Date("2026-12-30T23:59:00-05:00"), 3)).toEqual(["2026-12-31", "2027-01-01", "2027-01-02"]);
  });

  it("round-trips cursors and rejects garbage", () => {
    const at = new Date("2026-11-05T09:14:33.412Z");
    expect(decodeCursor(encodeCursor(at, "01JBQ4Z3H8X9T2K7M5N6P8R9SV"))).toEqual({
      receivedAt: at,
      eventId: "01JBQ4Z3H8X9T2K7M5N6P8R9SV",
    });
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from('["nope","x"]').toString("base64url"))).toBeNull();
  });
});

describe("project access", () => {
  it("only accepts access objects issued by the storage layer", async () => {
    const repo = new MemoryMetadataRepository();
    const user = repo.addUser("admin@example.test", "hash", "member");
    await repo.createProject(
      { userId: user.id, instanceRole: "member" },
      { id: "prj_test", name: "Test", retentionDays: 30 },
    );
    const forged = {
      projectId: "prj_test",
      userId: user.id,
      permissions: new Set(["keys.manage"]),
      viaInstanceAdmin: false,
    } as unknown as ProjectAccess;
    expect(() => assertProjectAccess(forged)).toThrow(TypeError);
    await expect(
      repo.createIngestionKey(forged, { keyId: "0123456789AB", keyHash: new Uint8Array(32), name: "" }),
    ).rejects.toThrow();
    const real = mintProjectAccess({
      projectId: "prj_test",
      userId: user.id,
      permissions: new Set(["project.read"]),
      viaInstanceAdmin: false,
    });
    expect(() => assertProjectAccess(real)).not.toThrow();
  });

  it("returns no access for non-members and full access for instance admins", async () => {
    const repo = new MemoryMetadataRepository();
    const owner = repo.addUser("owner@example.test", "hash", "member");
    const other = repo.addUser("other@example.test", "hash", "member");
    const admin = repo.addUser("admin@example.test", "hash", "admin");
    await repo.createProject(
      { userId: owner.id, instanceRole: "member" },
      { id: "prj_a", name: "A", retentionDays: 30 },
    );
    expect(await repo.resolveProjectAccess({ userId: other.id, instanceRole: "member" }, "prj_a")).toBeNull();
    const viaAdmin = await repo.resolveProjectAccess({ userId: admin.id, instanceRole: "admin" }, "prj_a");
    expect(viaAdmin?.viaInstanceAdmin).toBe(true);
    expect(viaAdmin?.permissions.has("project.delete")).toBe(true);
  });
});
