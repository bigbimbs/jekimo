import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CronMonitorInput, ProjectAccess } from "../src/index.js";
import {
  nextCronDate,
  PostgresCronRepository,
  PostgresMetadataRepository,
  PostgresNotificationRepository,
  sealNotification,
} from "../src/index.js";
import { createTestDatabase, hasDatabase, type TestDatabase } from "../src/testing.js";

it("calculates timezone-aware cron schedules across DST and rejects seconds/random fields", () => {
  expect(nextCronDate("0 9 * * *", "Africa/Lagos", new Date("2026-11-15T07:59:00Z")).toISOString()).toBe(
    "2026-11-15T08:00:00.000Z",
  );
  expect(nextCronDate("0 9 * * *", "America/New_York", new Date("2026-03-07T15:00:00Z")).toISOString()).toBe(
    "2026-03-08T13:00:00.000Z",
  );
  expect(() => nextCronDate("* * * * * *", "UTC", new Date())).toThrow();
  expect(() => nextCronDate("H * * * *", "UTC", new Date())).toThrow();
  expect(() => nextCronDate("0 2 * * *", "Not/AZone", new Date())).toThrow();
});
describe.skipIf(!hasDatabase)("cron monitoring storage", () => {
  let db: TestDatabase;
  let repository: PostgresCronRepository;
  let meta: PostgresMetadataRepository;
  let access: ProjectAccess;
  let other: ProjectAccess;
  let notifications: PostgresNotificationRepository;
  let channelId: string;
  const at = (time: string) => new Date(`2026-11-15T${time}Z`);
  const input = (): CronMonitorInput => ({
    name: "Backup",
    expression: "* * * * *",
    timezone: "UTC",
    graceSeconds: 10,
    maxRuntimeSeconds: 20,
    failureThreshold: 1,
    recoveryThreshold: 1,
    channelId,
  });
  beforeEach(async () => {
    db = await createTestDatabase();
    repository = new PostgresCronRepository(db.pool);
    meta = new PostgresMetadataRepository(db.pool);
    notifications = new PostgresNotificationRepository(db.pool);
    const user = (await meta.createFirstAdmin({ email: "admin@example.test", passwordHash: "synthetic" }))!;
    const actor = { userId: user.id, instanceRole: "admin" as const };
    await meta.createProject(actor, { id: "cron_one", name: "One", retentionDays: 30 });
    await meta.createProject(actor, { id: "cron_two", name: "Two", retentionDays: 30 });
    access = (await meta.resolveProjectAccess(actor, "cron_one"))!;
    other = (await meta.resolveProjectAccess(actor, "cron_two"))!;
    channelId = randomUUID();
    await notifications.saveChannel(
      access,
      { id: channelId, name: "Ops", kind: "email", enabled: true },
      sealNotification({ destination: "ops@example.test" }, "a".repeat(64), channelId),
    );
  });
  afterEach(async () => {
    await db?.close();
  });
  it("records successful runs once and protects project boundaries", async () => {
    const monitor = (await repository.create(access, input(), at("10:00:00")))!;
    const runId = randomUUID();
    expect(await repository.create(other, input(), at("10:00:00"))).toBeNull();
    expect(await repository.runs(other, monitor.id)).toBeNull();
    expect(await repository.checkIn(other.projectId, monitor.id, { runId, status: "started" }, at("10:01:00"))).toBe(
      "not_found",
    );
    await repository.checkIn(access.projectId, monitor.id, { runId, status: "started" }, at("10:01:00"));
    await repository.checkIn(access.projectId, monitor.id, { runId, status: "ok" }, at("10:01:05"));
    await repository.checkIn(access.projectId, monitor.id, { runId, status: "ok" }, at("10:01:06"));
    await repository.checkIn(access.projectId, monitor.id, { runId, status: "started" }, at("10:01:07"));
    expect(await repository.runs(access, monitor.id)).toHaveLength(1);
    expect((await repository.list(access))[0]).toMatchObject({
      health: "healthy",
      consecutiveSuccesses: 1,
      nextExpectedAt: at("10:02:00"),
    });
    expect(await repository.checkIn(access.projectId, monitor.id, { runId, status: "error" }, at("10:01:08"))).toBe(
      "conflict",
    );
  });
  it("opens one incident for missed runs and sends recovery after a successful next run", async () => {
    const monitor = (await repository.create(access, input(), at("10:00:00")))!;
    await Promise.all([repository.scan(at("10:01:11")), repository.scan(at("10:01:11"))]);
    expect(await repository.runs(access, monitor.id)).toHaveLength(1);
    expect(await notifications.listDeliveries(access)).toHaveLength(1);
    await repository.scan(at("10:02:11"));
    expect(await notifications.listDeliveries(access)).toHaveLength(1);
    await repository.checkIn(access.projectId, monitor.id, { runId: randomUUID(), status: "ok" }, at("10:03:01"));
    expect((await repository.list(access))[0]?.health).toBe("healthy");
    expect(await notifications.listDeliveries(access)).toHaveLength(2);
  });
  it("detects timeouts even when a late completion arrives before the scanner", async () => {
    const monitor = (await repository.create(access, input(), at("10:00:00")))!;
    const runId = randomUUID();
    await repository.checkIn(access.projectId, monitor.id, { runId, status: "started" }, at("10:01:00"));
    const result = await repository.checkIn(access.projectId, monitor.id, { runId, status: "ok" }, at("10:01:21"));
    expect(result).toMatchObject({ status: "timeout" });
    expect((await repository.list(access))[0]?.health).toBe("failing");
    await repository.scan(at("10:01:25"));
    expect(await notifications.listDeliveries(access)).toHaveLength(1);
  });
  it("supports overlapping runs, completion-first retries and consecutive thresholds", async () => {
    const monitor = (await repository.create(
      access,
      { ...input(), failureThreshold: 2, recoveryThreshold: 2 },
      at("10:00:00"),
    ))!;
    const a = randomUUID(),
      b = randomUUID();
    await repository.checkIn(access.projectId, monitor.id, { runId: a, status: "started" }, at("10:01:00"));
    await repository.checkIn(access.projectId, monitor.id, { runId: b, status: "started" }, at("10:01:01"));
    await repository.checkIn(access.projectId, monitor.id, { runId: a, status: "error" }, at("10:01:02"));
    expect(await notifications.listDeliveries(access)).toHaveLength(0);
    await repository.checkIn(access.projectId, monitor.id, { runId: b, status: "error" }, at("10:01:03"));
    expect(await notifications.listDeliveries(access)).toHaveLength(1);
    const c = randomUUID();
    await repository.checkIn(access.projectId, monitor.id, { runId: c, status: "ok" }, at("10:01:04"));
    await repository.checkIn(access.projectId, monitor.id, { runId: c, status: "started" }, at("10:01:05"));
    expect((await repository.list(access))[0]?.health).toBe("failing");
    await repository.checkIn(access.projectId, monitor.id, { runId: randomUUID(), status: "ok" }, at("10:01:06"));
    expect(await notifications.listDeliveries(access)).toHaveLength(2);
  });
  it("pauses without losing history and resumes from a fresh schedule", async () => {
    const monitor = (await repository.create(access, input(), at("10:00:00")))!;
    const runId = randomUUID();
    await repository.checkIn(access.projectId, monitor.id, { runId, status: "started" }, at("10:01:00"));
    await repository.setEnabled(access, monitor.id, false, at("10:01:01"));
    await repository.scan(at("11:00:00"));
    expect((await repository.runs(access, monitor.id))?.[0]?.status).toBe("cancelled");
    expect(await notifications.listDeliveries(access)).toHaveLength(0);
    expect(await repository.checkIn(access.projectId, monitor.id, { runId, status: "ok" }, at("10:01:02"))).toBe(
      "disabled",
    );
    await repository.setEnabled(access, monitor.id, true, at("11:00:00"));
    expect((await repository.list(access))[0]?.nextExpectedAt).toEqual(at("11:01:00"));
    expect(
      await repository.checkIn(access.projectId, monitor.id, { runId, status: "ok" }, at("11:00:01")),
    ).toMatchObject({ status: "cancelled" });
  });
  it("collapses downtime gaps without creating an alert flood and prunes old history", async () => {
    const monitor = (await repository.create(access, input(), at("10:00:00")))!;
    await repository.scan(at("15:00:00"));
    expect(await repository.runs(access, monitor.id)).toHaveLength(1);
    expect((await repository.list(access))[0]?.nextExpectedAt).toEqual(at("15:00:00"));
    await repository.scan(at("15:00:00"));
    expect(await repository.runs(access, monitor.id)).toHaveLength(1);
    await repository.prune(new Date("2027-01-01T00:00:00Z"));
    expect(await repository.runs(access, monitor.id)).toHaveLength(0);
  });
  it("bounds check-ins per minute even for repeated run ids", async () => {
    const monitor = (await repository.create(access, input(), at("10:00:00")))!;
    const runId = randomUUID();
    for (let i = 0; i < 120; i++)
      await repository.checkIn(access.projectId, monitor.id, { runId, status: "ok" }, at("10:00:01"));
    expect(await repository.checkIn(access.projectId, monitor.id, { runId, status: "ok" }, at("10:00:01"))).toBe(
      "rate_limited",
    );
    expect(
      await repository.checkIn(access.projectId, monitor.id, { runId, status: "ok" }, at("10:01:01")),
    ).toMatchObject({ status: "ok" });
  });
});
