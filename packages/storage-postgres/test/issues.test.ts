// Skipped unless JEKIMO_DATABASE_URL is set.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type IssueSummary, PostgresMetadataRepository, type ProjectAccess } from "../src/index.js";
import { createTestDatabase, hasDatabase, type TestDatabase } from "../src/testing.js";

describe.skipIf(!hasDatabase)("PostgreSQL issues", () => {
  let db: TestDatabase;
  let meta: PostgresMetadataRepository;
  let a: ProjectAccess;
  let b: ProjectAccess;
  const base = Date.now() - 60 * 60 * 1000;
  const at = (minutes: number) => new Date(base + minutes * 60_000);

  function summary(fingerprint: string, overrides: Partial<IssueSummary> = {}): IssueSummary {
    return {
      fingerprint,
      title: `synthetic ${fingerprint}`,
      kind: "exception",
      lastSeverity: "error",
      eventCount: 1,
      firstSeen: at(0),
      lastSeen: at(0),
      ...overrides,
    };
  }

  async function issue(access: ProjectAccess, fingerprint: string) {
    const page = await meta.listIssues(access, { limit: 100 });
    const found = page.issues.find((i) => i.fingerprint === fingerprint);
    if (!found) throw new Error(`no issue ${fingerprint}`);
    return found;
  }

  async function auditFor(targetId: string) {
    const { rows } = await db.pool.query(
      "SELECT action, actor_user_id, project_id, details FROM audit_log WHERE target_type = 'issue' AND target_id = $1 ORDER BY id",
      [targetId],
    );
    return rows;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    meta = new PostgresMetadataRepository(db.pool);
    const admin = await meta.createFirstAdmin({ email: "issues@example.test", passwordHash: "$argon2id$synthetic" });
    const actor = { userId: admin!.id, instanceRole: "admin" as const };
    await meta.createProject(actor, { id: "prj_iss_a", name: "A", retentionDays: 30 });
    await meta.createProject(actor, { id: "prj_iss_b", name: "B", retentionDays: 30 });
    a = (await meta.resolveProjectAccess(actor, "prj_iss_a"))!;
    b = (await meta.resolveProjectAccess(actor, "prj_iss_b"))!;
  });

  afterAll(async () => {
    await db?.close();
  });

  it("merges summaries: counts forward, latest event by last_seen, environments as a set", async () => {
    await meta.upsertIssues(a.projectId, [
      summary("fp-merge", { lastSeen: at(5), lastEventId: "01JBQ4Z3H8X9T2K7M5N6P8R9SV", environments: ["staging"] }),
    ]);
    await meta.upsertIssues(a.projectId, [
      summary("fp-merge", {
        eventCount: 2,
        lastSeen: at(6),
        lastEventId: "01JBQ50A6D2V8W4Y1Z3X5C7B9N",
        environments: ["production", "staging"],
      }),
    ]);
    // An older summary keeps the newer latest event.
    await meta.upsertIssues(a.projectId, [
      summary("fp-merge", { eventCount: 2, lastSeen: at(5), lastEventId: "01JBQ4Z3H8X9T2K7M5N6P8R9SV" }),
    ]);
    const i = await issue(a, "fp-merge");
    expect(i).toMatchObject({
      projectId: a.projectId,
      status: "unresolved",
      eventCount: 2,
      lastEventId: "01JBQ50A6D2V8W4Y1Z3X5C7B9N",
      environments: ["production", "staging"],
    });
    expect(i.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(i.lastSeen.getTime()).toBe(at(6).getTime());
  });

  it("lists with filters and a cursor, newest last_seen first", async () => {
    await meta.upsertIssues(b.projectId, [
      summary("b1", { lastSeen: at(10), environments: ["production"] }),
      summary("b2", { kind: "log", lastSeverity: "warning", lastSeen: at(20), firstSeen: at(15) }),
      summary("b3", { lastSeen: at(20), firstSeen: at(20) }),
      summary("b4", { lastSeen: at(30), firstSeen: at(30), environments: ["staging"] }),
    ]);
    const fps = async (q: Parameters<typeof meta.listIssues>[1]) =>
      (await meta.listIssues(b, q)).issues.map((i) => i.fingerprint);
    expect(await fps({ limit: 10 })).toHaveLength(4);
    expect((await fps({ limit: 10 }))[0]).toBe("b4");
    expect(await fps({ limit: 10, kinds: ["log"] })).toEqual(["b2"]);
    expect(await fps({ limit: 10, severities: ["warning"] })).toEqual(["b2"]);
    expect(await fps({ limit: 10, environment: "production" })).toEqual(["b1"]);
    expect(await fps({ limit: 10, from: at(20), to: at(25) })).toEqual(expect.arrayContaining(["b2", "b3"]));
    expect(await fps({ limit: 10, from: at(20), to: at(25) })).toHaveLength(2);
    expect(await fps({ limit: 10, statuses: ["resolved"] })).toEqual([]);

    // Two issues share last_seen; the cursor still visits each once.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await meta.listIssues(b, { limit: 1, ...(cursor !== undefined && { cursor }) });
      seen.push(...page.issues.map((i) => i.fingerprint));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    await expect(meta.listIssues(b, { limit: 1, cursor: "bad" })).rejects.toThrow(RangeError);
  });

  it("changes status once per change and audit-logs it", async () => {
    const i = await issue(a, "fp-merge");
    const resolved = await meta.setIssueStatus(a, i.id, "resolved", "203.0.113.7");
    expect(resolved).toMatchObject({ id: i.id, status: "resolved" });
    expect(resolved!.statusChangedAt).toBeInstanceOf(Date);
    await meta.setIssueStatus(a, i.id, "resolved");
    await meta.setIssueStatus(a, i.id, "ignored");
    await meta.setIssueStatus(a, i.id, "unresolved");
    expect(await auditFor(i.id)).toEqual([
      {
        action: "issue.resolved",
        actor_user_id: a.userId,
        project_id: a.projectId,
        details: { from: "unresolved", to: "resolved" },
      },
      {
        action: "issue.ignored",
        actor_user_id: a.userId,
        project_id: a.projectId,
        details: { from: "resolved", to: "ignored" },
      },
      {
        action: "issue.reopened",
        actor_user_id: a.userId,
        project_id: a.projectId,
        details: { from: "ignored", to: "unresolved" },
      },
    ]);
  });

  it("reopens a resolved issue only for events received after the resolution", async () => {
    await meta.upsertIssues(a.projectId, [summary("fp-regress", { lastSeen: at(1) })]);
    const i = await issue(a, "fp-regress");
    await meta.setIssueStatus(a, i.id, "resolved");
    await meta.upsertIssues(a.projectId, [summary("fp-regress", { eventCount: 2, lastSeen: at(2) })]);
    expect((await meta.getIssue(a, i.id))!.status).toBe("resolved");
    const later = new Date(Date.now() + 60_000);
    await meta.upsertIssues(a.projectId, [summary("fp-regress", { eventCount: 3, lastSeen: later })]);
    expect(await meta.getIssue(a, i.id)).toMatchObject({ status: "unresolved", eventCount: 3 });
    expect((await auditFor(i.id)).at(-1)).toEqual({
      action: "issue.regressed",
      actor_user_id: null,
      project_id: a.projectId,
      details: { from: "resolved", to: "unresolved" },
    });
  });

  it("keeps ignored issues ignored when new events arrive", async () => {
    await meta.upsertIssues(a.projectId, [summary("fp-ignored", { lastSeen: at(1) })]);
    const i = await issue(a, "fp-ignored");
    await meta.setIssueStatus(a, i.id, "ignored");
    await meta.upsertIssues(a.projectId, [summary("fp-ignored", { lastSeen: new Date(Date.now() + 60_000) })]);
    expect((await meta.getIssue(a, i.id))!.status).toBe("ignored");
  });

  it("never reads or changes another project's issue", async () => {
    const other = await issue(b, "b1");
    expect(await meta.getIssue(a, other.id)).toBeNull();
    expect(await meta.setIssueStatus(a, other.id, "resolved")).toBeNull();
    expect((await meta.getIssue(b, other.id))!.status).toBe("unresolved");
    expect(await meta.getIssue(a, "not-a-uuid")).toBeNull();
    expect(await meta.setIssueStatus(a, "not-a-uuid", "resolved")).toBeNull();
  });
});
