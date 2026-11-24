import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor, IssueSummary, ProjectAccess } from "../src/index.js";
import {
  openNotification,
  PostgresMetadataRepository,
  PostgresNotificationRepository,
  sealNotification,
} from "../src/index.js";
import { createTestDatabase, hasDatabase, type TestDatabase } from "../src/testing.js";

const key = "a".repeat(64);
it("encrypts notification settings with a context-bound authenticated cipher", () => {
  const encrypted = sealNotification({ password: "synthetic-secret" }, key, "smtp");
  expect(encrypted).not.toContain("synthetic-secret");
  expect(openNotification(encrypted, key, "smtp")).toEqual({ password: "synthetic-secret" });
  expect(() => openNotification(encrypted, key, "other")).toThrow();
  expect(() => openNotification(encrypted, "b".repeat(64), "smtp")).toThrow();
});
describe.skipIf(!hasDatabase)("notification storage", () => {
  let db: TestDatabase;
  let meta: PostgresMetadataRepository;
  let repo: PostgresNotificationRepository;
  let actor: Actor;
  let access: ProjectAccess;
  let other: ProjectAccess;
  let channelId: string;
  const summary = (fingerprint = "test"): IssueSummary => ({
    fingerprint,
    title: "Synthetic failure",
    kind: "exception",
    lastSeverity: "error",
    eventCount: 1,
    firstSeen: new Date(),
    lastSeen: new Date(),
  });
  beforeEach(async () => {
    db = await createTestDatabase();
    meta = new PostgresMetadataRepository(db.pool);
    repo = new PostgresNotificationRepository(db.pool);
    const user = await meta.createFirstAdmin({ email: "admin@example.test", passwordHash: "synthetic" });
    actor = { userId: user!.id, instanceRole: "admin" };
    await meta.createProject(actor, { id: "one", name: "One", retentionDays: 30 });
    await meta.createProject(actor, { id: "two", name: "Two", retentionDays: 30 });
    access = (await meta.resolveProjectAccess(actor, "one"))!;
    other = (await meta.resolveProjectAccess(actor, "two"))!;
    channelId = randomUUID();
    await repo.saveChannel(
      access,
      { id: channelId, name: "Ops", kind: "webhook", enabled: true },
      sealNotification({ destination: "https://example.test/hook", signingSecret: "s".repeat(32) }, key, channelId),
    );
  });
  afterEach(async () => {
    await db?.close();
  });
  const rule = async (trigger: "new_issue" | "regression" = "new_issue") => {
    const id = randomUUID();
    await repo.saveRule(access, { id, name: "Errors", channelId, trigger, cooldownMinutes: 15, enabled: true });
    return id;
  };
  it("schedules one alert despite replay and concurrent schedulers, with exclusive delivery leases", async () => {
    await rule();
    const s = summary();
    await meta.upsertIssues("one", [s]);
    await meta.upsertIssues("one", [s]);
    await Promise.all([repo.scheduleAlerts(), repo.scheduleAlerts()]);
    expect(await repo.listDeliveries(access)).toHaveLength(1);
    const claims = await Promise.all([repo.claim(), repo.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const job = claims.find(Boolean)!;
    await repo.finish(job, null);
    expect((await repo.listDeliveries(access))[0]?.status).toBe("sent");
  });
  it("captures regressions atomically and suppresses repeated alerts in the cooldown", async () => {
    await rule("regression");
    await meta.upsertIssues("one", [summary()]);
    const issue = (await meta.listIssues(access, { limit: 10 })).issues[0]!;
    await meta.setIssueStatus(access, issue.id, "resolved");
    await meta.upsertIssues("one", [{ ...summary(), eventCount: 2, lastSeen: new Date(Date.now() + 1000) }]);
    await repo.scheduleAlerts();
    expect(await repo.listDeliveries(access)).toHaveLength(1);
    await meta.setIssueStatus(access, issue.id, "resolved");
    await meta.upsertIssues("one", [{ ...summary(), eventCount: 3, lastSeen: new Date(Date.now() + 2000) }]);
    await repo.scheduleAlerts();
    expect(await repo.listDeliveries(access)).toHaveLength(1);
  });
  it("does not backfill old issues, notify normal logs, or attach another project's channel", async () => {
    await meta.upsertIssues("one", [summary("old")]);
    await rule();
    await meta.upsertIssues("one", [{ ...summary("log"), kind: "log", lastSeverity: "info" }]);
    await repo.scheduleAlerts();
    expect(await repo.listDeliveries(access)).toEqual([]);
    expect(await repo.listChannels(other)).toEqual([]);
    expect(
      await repo.saveRule(other, {
        id: randomUUID(),
        name: "Bad",
        channelId,
        trigger: "new_issue",
        cooldownMinutes: 1,
        enabled: true,
      }),
    ).toBe(false);
    expect(await repo.setChannelEnabled(other, channelId, false)).toBe(false);
    expect(await repo.enqueueTest(other, channelId)).toBe(false);
  });
  it("retries failures, rejects stale acknowledgements, and stops at five attempts", async () => {
    await repo.enqueueTest(access, channelId);
    let job = (await repo.claim())!;
    await repo.finish(job, "connection_failed");
    expect((await repo.listDeliveries(access))[0]?.status).toBe("retrying");
    expect(await repo.claim()).toBeNull();
    for (let n = 2; n <= 5; n++) {
      await db.pool.query("UPDATE notification_deliveries SET available_at = now() - interval '1 second'");
      const next = (await repo.claim())!;
      await repo.finish(job, null);
      expect((await repo.listDeliveries(access))[0]?.status).toBe("sending");
      job = next;
      await repo.finish(job, "connection_failed");
    }
    expect((await repo.listDeliveries(access))[0]).toMatchObject({ status: "failed", attempts: 5 });
    expect(await repo.claim()).toBeNull();
  });
  it("reclaims a crashed delivery and cancels deliveries for disabled channels", async () => {
    await repo.enqueueTest(access, channelId);
    const first = (await repo.claim())!;
    await db.pool.query("UPDATE notification_deliveries SET available_at = now() - interval '1 second'");
    const second = (await repo.claim())!;
    expect(second.id).toBe(first.id);
    expect(second.lease).not.toBe(first.lease);
    await repo.finish(second, "connection_failed");
    await repo.setChannelEnabled(access, channelId, false);
    await db.pool.query("UPDATE notification_deliveries SET available_at = now() - interval '1 second'");
    expect(await repo.claim()).toBeNull();
    expect((await repo.listDeliveries(access))[0]?.error).toBe("channel_disabled");
  });
  it("rate limits concurrent test requests and does not persist secrets in audit details", async () => {
    expect(
      (await Promise.all([repo.enqueueTest(access, channelId), repo.enqueueTest(access, channelId)])).filter(Boolean),
    ).toHaveLength(1);
    await repo.saveSmtp(actor, sealNotification({ password: "synthetic-password" }, key, "smtp"));
    const rows = await db.pool.query("SELECT details FROM audit_log");
    expect(JSON.stringify(rows.rows)).not.toContain("synthetic-password");
  });
});
