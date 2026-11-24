import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AlertRule, ProjectAccess, QueryObservation } from "../src/index.js";
import { PostgresMetadataRepository, PostgresNotificationRepository } from "../src/index.js";
import { createTestDatabase, hasDatabase, type TestDatabase } from "../src/testing.js";

describe.skipIf(!hasDatabase)("slow-query alerts", () => {
  let db: TestDatabase,
    repo: PostgresNotificationRepository,
    access: ProjectAccess,
    other: ProjectAccess,
    rule: AlertRule;
  const observation = (eventId = randomUUID(), fields: Partial<QueryObservation> = {}): QueryObservation => ({
    eventId,
    receivedAt: new Date(),
    environment: "production",
    database: { name: "invoices.list", system: "postgresql", operation: "select", duration_ms: 500, status: "ok" },
    ...fields,
  });
  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new PostgresNotificationRepository(db.pool);
    const meta = new PostgresMetadataRepository(db.pool);
    const admin = await meta.createFirstAdmin({ email: "query-admin@example.test", passwordHash: "synthetic" });
    const actor = { userId: admin!.id, instanceRole: "admin" as const };
    for (const id of ["query_one", "query_two"]) await meta.createProject(actor, { id, name: id, retentionDays: 30 });
    access = (await meta.resolveProjectAccess(actor, "query_one"))!;
    other = (await meta.resolveProjectAccess(actor, "query_two"))!;
    const channelId = randomUUID();
    await repo.saveChannel(
      access,
      { id: channelId, name: "Query alerts", kind: "webhook", enabled: true },
      "synthetic-encrypted",
    );
    rule = {
      id: randomUUID(),
      name: "Slow invoices",
      channelId,
      trigger: "slow_query",
      thresholdMs: 500,
      environment: "production",
      queryName: "invoices.list",
      cooldownMinutes: 15,
      enabled: true,
    };
    await repo.saveRule(access, rule);
  });
  afterEach(async () => {
    await db?.close();
  });
  it("stores rules, isolates projects and rejects cross-project destinations", async () => {
    expect(await repo.listRules(access)).toEqual([rule]);
    expect(await repo.listRules(other)).toEqual([]);
    expect(await repo.saveRule(other, { ...rule, id: randomUUID() })).toBe(false);
    await expect(repo.listRules({ ...access, permissions: new Set() })).rejects.toThrow();
    expect(await repo.scheduleQueryAlerts(other.projectId, [observation()])).toBe(0);
    expect(await repo.listDeliveries(access)).toHaveLength(0);
  });
  it("serializes duplicate processing and enforces a rule-wide cooldown", async () => {
    const first = observation();
    const results = await Promise.all([
      repo.scheduleQueryAlerts(access.projectId, [first]),
      repo.scheduleQueryAlerts(access.projectId, [first]),
    ]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await repo.scheduleQueryAlerts(access.projectId, [observation()])).toBe(0);
    await db.pool.query("UPDATE notification_rules SET last_query_alert_at=now()-interval '1 hour'");
    expect(await repo.scheduleQueryAlerts(access.projectId, [first])).toBe(0);
    expect(await repo.scheduleQueryAlerts(access.projectId, [observation()])).toBe(1);
    expect(await repo.listDeliveries(access)).toHaveLength(2);
    const payload = (await db.pool.query("SELECT payload FROM notification_deliveries LIMIT 1")).rows[0]?.payload;
    expect(payload).toMatchObject({
      subject: "Slow database query",
      projectId: access.projectId,
      trigger: "slow_query",
    });
    expect(payload.text).toBe("invoices.list took 500 ms (threshold: 500 ms).");
  });
  it("matches exact environment/name and inclusive duration without backfilling old calls", async () => {
    const before = observation(undefined, { receivedAt: new Date(Date.now() - 10000) });
    const base = observation();
    expect(
      await repo.scheduleQueryAlerts(access.projectId, [
        before,
        observation(undefined, { environment: "staging" }),
        observation(undefined, { database: { ...base.database, name: "invoices.other" } }),
        observation(undefined, { database: { ...base.database, duration_ms: 499.9 } }),
      ]),
    ).toBe(0);
    expect(await repo.scheduleQueryAlerts(access.projectId, [observation()])).toBe(1);
  });
  it("does not replay disabled rules or channels after enabling and edits apply prospectively", async () => {
    await repo.saveRule(access, { ...rule, enabled: false });
    const paused = observation();
    expect(await repo.scheduleQueryAlerts(access.projectId, [paused])).toBe(0);
    await repo.saveRule(access, rule);
    expect(await repo.scheduleQueryAlerts(access.projectId, [paused])).toBe(0);
    await repo.setChannelEnabled(access, rule.channelId, false);
    const disabled = observation();
    expect(await repo.scheduleQueryAlerts(access.projectId, [disabled])).toBe(0);
    await repo.setChannelEnabled(access, rule.channelId, true);
    expect(await repo.scheduleQueryAlerts(access.projectId, [disabled])).toBe(0);
    const earlier = observation(undefined, { receivedAt: new Date(Date.now() - 1000) });
    await repo.saveRule(access, { ...rule, thresholdMs: 100 });
    expect(await repo.scheduleQueryAlerts(access.projectId, [earlier])).toBe(0);
    expect(await repo.scheduleQueryAlerts(access.projectId, [observation()])).toBe(1);
  });
  it("rolls back deduplication and cooldown if enqueue fails, so retries recover", async () => {
    await db.pool.query(
      "CREATE FUNCTION reject_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$",
    );
    await db.pool.query(
      "CREATE TRIGGER reject_delivery BEFORE INSERT ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION reject_delivery()",
    );
    const input = observation();
    await expect(repo.scheduleQueryAlerts(access.projectId, [input])).rejects.toThrow("synthetic failure");
    expect((await db.pool.query("SELECT * FROM notification_query_receipts")).rows).toHaveLength(0);
    await db.pool.query("DROP TRIGGER reject_delivery ON notification_deliveries");
    expect(await repo.scheduleQueryAlerts(access.projectId, [input])).toBe(1);
  });
  it("bounds queue growth, rejects stale calls, and prunes receipts", async () => {
    await db.pool.query(
      "INSERT INTO notification_deliveries(project_id,channel_name,kind,payload) SELECT $1,'Synthetic','email','{}'::jsonb FROM generate_series(1,1000)",
      [access.projectId],
    );
    expect(
      await repo.scheduleQueryAlerts(access.projectId, [
        observation(undefined, { receivedAt: new Date(Date.now() - 2 * 86400000) }),
      ]),
    ).toBe(0);
    expect(await repo.scheduleQueryAlerts(access.projectId, [observation()])).toBe(1);
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM notification_deliveries WHERE error='queue_full'")).rows[0]
        ?.n,
    ).toBe(1);
    await db.pool.query("UPDATE notification_query_receipts SET received_at=now()-interval '9 days'");
    await repo.prune();
    expect((await db.pool.query("SELECT * FROM notification_query_receipts")).rows).toHaveLength(0);
  });
});
