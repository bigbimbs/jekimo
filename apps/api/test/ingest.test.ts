import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { generateIngestionKey } from "../src/keys.js";
import { type Harness, harness, ingestEvent, projectWithKey, signIn } from "./helpers.js";

let h: Harness;
let key: string;
let keyId: string;
let projectId: string;

beforeEach(async () => {
  h = await harness();
  const owner = await signIn(h, "owner@example.test");
  ({ key, keyId, projectId } = await projectWithKey(h, owner));
});

function ingest(body: unknown, headers: Record<string, string> = {}) {
  return h.app.inject({
    method: "POST",
    url: "/api/v1/ingest",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    payload: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
}

describe("authentication", () => {
  it.each([
    ["missing", undefined],
    ["malformed", "Bearer not-a-key"],
    ["unknown", `Bearer ${generateIngestionKey().key}`],
    ["wrong secret", () => `Bearer jk_${keyId}_${"a".repeat(32)}`],
    ["basic scheme", () => `Basic ${key}`],
  ])("rejects a %s key with 401", async (_name, header) => {
    const value = typeof header === "function" ? header() : header;
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "content-type": "application/json", ...(value !== undefined && { authorization: value }) },
      payload: JSON.stringify({ events: [ingestEvent()] }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    expect(h.queue.jobs).toHaveLength(0);
  });

  it("rejects a revoked key", async () => {
    h.metadata.keys[0]!.revokedAt = new Date();
    expect((await ingest({ events: [ingestEvent()] })).statusCode).toBe(401);
  });

  it("does not accept a session cookie instead of a key", async () => {
    const user = await signIn(h, "cookie@example.test");
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { ...user.headers, "content-type": "application/json" },
      payload: JSON.stringify({ events: [ingestEvent()] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a disabled project", async () => {
    h.metadata.projects[0]!.disabled = true;
    const res = await ingest({ events: [ingestEvent()] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("project_disabled");
  });
});

describe("request limits", () => {
  it("returns 415 for a non-JSON content type", async () => {
    const res = await ingest("events=1", { "content-type": "text/plain" });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  it("accepts a utf-8 charset parameter", async () => {
    expect(
      (await ingest({ events: [ingestEvent()] }, { "content-type": "application/json; charset=utf-8" })).statusCode,
    ).toBe(202);
  });

  it("returns 415 for an unsupported content encoding", async () => {
    const res = await ingest(JSON.stringify({ events: [ingestEvent()] }), { "content-encoding": "br" });
    expect(res.statusCode).toBe(415);
  });

  it("returns 413 from Content-Length before reading the body", async () => {
    const res = await ingest("{}", { "content-length": String(2 * 1024 * 1024) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");
  });

  it("returns 413 for a body over 1 MiB", async () => {
    const big = JSON.stringify({ events: [ingestEvent({ message: "x".repeat(1024 * 1024) })] });
    expect((await ingest(big)).statusCode).toBe(413);
  });

  it("stops decompressing at 1 MiB", async () => {
    const bomb = gzipSync(
      Buffer.from(JSON.stringify({ events: [ingestEvent({ attributes: { pad: " ".repeat(4 * 1024 * 1024) } })] })),
    );
    expect(bomb.length).toBeLessThan(64 * 1024);
    const res = await ingest(bomb, { "content-encoding": "gzip" });
    expect(res.statusCode).toBe(413);
  });

  it("accepts gzip bodies", async () => {
    const res = await ingest(gzipSync(Buffer.from(JSON.stringify({ events: [ingestEvent()] }))), {
      "content-encoding": "gzip",
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toEqual(["01JBQ4Z3H8X9T2K7M5N6P8R9SV"]);
  });

  it.each([
    ["not JSON", "{nope", "invalid_json"],
    ["not UTF-8", Buffer.from([0x7b, 0xff, 0x7d]), "invalid_json"],
    ["not an object", "[1,2]", "invalid_request"],
    ["missing events", "{}", "invalid_request"],
    ["empty events", '{"events":[]}', "invalid_request"],
  ])("returns 400 when the body is %s", async (_name, body, code) => {
    const res = await ingest(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
    expect(res.body).not.toContain("nope");
  });

  it("returns 400 too_many_events over 100 events", async () => {
    const res = await ingest({ events: Array.from({ length: 101 }, () => ingestEvent()) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("too_many_events");
  });
});

describe("accepted requests", () => {
  it("queues accepted events stamped with the key's project and returns per-event results", async () => {
    const res = await ingest({
      sent_at: "2026-11-05T09:14:59.000Z",
      events: [
        ingestEvent(),
        ingestEvent({ event_id: "01JBQ50A6D2V8W4Y1Z3X5C7B9N", message: undefined }),
        ingestEvent(),
        ingestEvent({ event_id: "01JBQ50A6D2V8W4Y1Z3X5C7B9P", project_id: "prj_someone_else" }),
        ingestEvent({ event_id: "01JBQ50A6D2V8W4Y1Z3X5C7B9Q", future_field: true }),
      ],
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toEqual(["01JBQ4Z3H8X9T2K7M5N6P8R9SV", "01JBQ50A6D2V8W4Y1Z3X5C7B9Q"]);
    expect(body.rejected.map((r: { index: number }) => r.index)).toEqual([1, 3]);
    expect(body.rejected[1].errors[0].code).toBe("forbidden");
    expect(body.warnings[0]).toMatchObject({ index: 4, code: "unknown_field" });
    expect(res.headers["x-jekimo-request-id"]).toEqual(expect.any(String));
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();

    expect(h.queue.jobs).toHaveLength(1);
    const job = h.queue.jobs[0]!.payload;
    expect(job.project_id).toBe(projectId);
    expect(job.key_id).toBe(keyId);
    expect(job.received_at).toBe("2026-11-05T09:15:00.000Z");
    expect(job.skew_ms).toBe(1000);
    expect(job.events.map((e) => e.event_id)).toEqual(body.accepted);
    expect(job.events.every((e) => e.project_id === undefined)).toBe(true);
  });

  it("returns 202 with only rejections and queues nothing", async () => {
    const res = await ingest({ events: [ingestEvent({ severity: "loud" })] });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toEqual([]);
    expect(h.queue.jobs).toHaveLength(0);
  });

  it("returns 503 with Retry-After and acknowledges nothing when the queue fails", async () => {
    h.queue.failEnqueue = true;
    const res = await ingest({ events: [ingestEvent()] });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.json()).toEqual({ error: { code: "unavailable", message: expect.any(String), retry_after: 5 } });
  });

  it("returns 503 with a longer Retry-After when the queue is full", async () => {
    h = await harness({ queueMaxDepth: 1 });
    ({ key, keyId, projectId } = await projectWithKey(h, await signIn(h, "owner@example.test")));
    expect((await ingest({ events: [ingestEvent()] })).statusCode).toBe(202);
    const res = await ingest({ events: [ingestEvent()] });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.json()).toEqual({ error: { code: "unavailable", message: expect.any(String), retry_after: 30 } });
    expect(h.queue.jobs).toHaveLength(1);
  });
});
