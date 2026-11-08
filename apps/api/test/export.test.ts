/**
 * Per-project export (issue #30) against the in-memory stores: stored-form
 * NDJSON, time range, gzip, the data.export permission, the audit entry, and
 * isolation scoped in the query (docs/access-model.md, "Authorization
 * enforcement", rule 4).
 */

import { gunzipSync } from "node:zlib";
import { validateEvent } from "@jekimo/event-schema";
import { beforeAll, describe, expect, it } from "vitest";
import { type Harness, harness, projectWithKey, type SignedIn, setRole, signIn, storeEvent } from "./helpers.js";

const A = "prj_export_a";
const B = "prj_export_b";
const ID = (n: number) => `01JBQ4Z3H8X9T2K7M5N6P8R${String(n).padStart(3, "0")}`;

let h: Harness;
let alice: SignedIn;
let bob: SignedIn;
let viewer: SignedIn;
let aliceKey: string;
let bobKey: string;
const at = (secondsAgo: number) => new Date(h.now.value.getTime() - secondsAgo * 1000);

function exportOf(user: SignedIn, project: string, query = "", headers: Record<string, string> = {}) {
  return h.app.inject({
    method: "GET",
    url: `/api/v1/projects/${project}/export${query}`,
    headers: { ...user.headers, ...headers },
  });
}

function lines(body: string): Record<string, unknown>[] {
  return body
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeAll(async () => {
  h = await harness();
  alice = await signIn(h, "alice@example.test");
  bob = await signIn(h, "bob@example.test");
  viewer = await signIn(h, "viewer@example.test");
  ({ key: aliceKey } = await projectWithKey(h, alice, A));
  ({ key: bobKey } = await projectWithKey(h, bob, B));
  setRole(h, A, viewer.userId, "viewer");
  await storeEvent(
    h,
    A,
    {
      event_id: ID(1),
      kind: "exception",
      severity: "error",
      message: "Database request failed",
      exception: { type: "DbError", value: "connection reset", stacktrace: "at charge (billing.js:10:5)" },
      context: { request_id: "req_1" },
      attributes: { retry_count: 2 },
    },
    at(300),
  );
  await storeEvent(h, A, { event_id: ID(2), message: "second" }, at(200));
  await storeEvent(h, A, { event_id: ID(3), message: "third" }, at(100));
  await storeEvent(h, B, { event_id: ID(9), message: "bob's private event" }, at(150));
});

describe("GET /api/v1/projects/:id/export", () => {
  it("streams every event of the project as stored-form NDJSON, oldest first", async () => {
    const res = await exportOf(alice, A);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="jekimo-${A}.ndjson"`);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.endsWith("\n")).toBe(true);
    const events = lines(res.body);
    expect(events.map((e) => e.event_id)).toEqual([ID(1), ID(2), ID(3)]);
    for (const e of events) {
      const result = validateEvent(e, { mode: "stored", now: h.now.value });
      expect(result).toMatchObject({ ok: true, warnings: [] });
      expect(e.project_id).toBe(A);
    }
    expect(events[0]).toMatchObject({
      exception: { type: "DbError", value: "connection reset" },
      context: { request_id: "req_1" },
      attributes: { retry_count: 2 },
    });
  });

  it("filters by received time, from inclusive and to exclusive", async () => {
    const from = at(200).toISOString();
    const to = at(100).toISOString();
    const res = await exportOf(alice, A, `?from=${from}&to=${to}`);
    expect(res.statusCode).toBe(200);
    expect(lines(res.body).map((e) => e.event_id)).toEqual([ID(2)]);
    const empty = await exportOf(alice, A, `?from=${at(50).toISOString()}`);
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toBe("");
  });

  it("gzips the stream on request", async () => {
    const plain = await exportOf(alice, A);
    const res = await exportOf(alice, A, "?compression=gzip");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="jekimo-${A}.ndjson.gz"`);
    expect(gunzipSync(res.rawPayload).toString("utf8")).toBe(plain.body);
  });

  it("rejects a bad range or compression before writing anything", async () => {
    for (const query of [
      "?from=yesterday",
      "?to=2026-13-01T00:00:00Z",
      `?from=${at(10).toISOString()}&to=${at(20).toISOString()}`,
      "?compression=zstd",
    ]) {
      const res = await exportOf(alice, A, query);
      expect({ query, status: res.statusCode, code: res.json().error.code }).toEqual({
        query,
        status: 400,
        code: "invalid_request",
      });
    }
  });

  it("audit-logs who exported which project and range, never the content", async () => {
    const before = h.metadata.audit.length;
    const to = at(100).toISOString();
    await exportOf(alice, A, `?to=${to}&compression=gzip`);
    const entries = h.metadata.audit.slice(before);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorUserId: alice.userId,
      action: "data.exported",
      targetType: "project",
      targetId: A,
      projectId: A,
      viaInstanceAdmin: false,
      details: { from: null, to, compression: "gzip" },
    });
    expect(JSON.stringify(entries[0])).not.toContain("Database request failed");
  });

  it("records instance-admin authority in the audit entry", async () => {
    const admin = await signIn(h, "instance-admin@example.test", "admin");
    const res = await exportOf(admin, A);
    expect(res.statusCode).toBe(200);
    expect(lines(res.body)).toHaveLength(3);
    expect(h.metadata.audit.at(-1)).toMatchObject({ actorUserId: admin.userId, viaInstanceAdmin: true });
  });

  it("needs data.export: a viewer gets 403 and nothing is audited", async () => {
    const before = h.metadata.audit.length;
    const res = await exportOf(viewer, A);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    expect(h.metadata.audit.length).toBe(before);
  });

  it("never exports another project's data by changing the id", async () => {
    const res = await exportOf(alice, B);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(res.body).not.toContain("bob's private event");
    const missing = await exportOf(alice, "prj_does_not_exist");
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toBe(res.body);
    const own = await exportOf(bob, B);
    expect(lines(own.body).map((e) => e.event_id)).toEqual([ID(9)]);
    expect(lines((await exportOf(alice, A)).body).map((e) => e.event_id)).not.toContain(ID(9));
  });

  it("contains no ingestion keys, password hashes, or session tokens", async () => {
    const res = await exportOf(alice, A);
    const user = h.metadata.users.find((u) => u.id === alice.userId)!;
    for (const secret of [
      aliceKey,
      bobKey,
      user.passwordHash,
      alice.cookie.split("=")[1]!,
      alice.csrf,
      "0123456789AB", // key_id: storage metadata, not part of the envelope
    ]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it("refuses an ingestion key", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${A}/export`,
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
