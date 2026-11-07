/**
 * Rate limits, quotas, and disk-full refusal on POST /api/v1/ingest
 * (docs/ingestion-protocol.md, "Processing" steps 2 and 3, "Request-level
 * errors", "Headers on every response"; docs/retention.md, "Quotas" and
 * "Disk safety"), and the project limits endpoints.
 */

import { DiskMonitor } from "@jekimo/storage-postgres";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { fakeHasher, type Harness, harness, ingestEvent, projectWithKey, type SignedIn, signIn } from "./helpers.js";

let h: Harness;
let key: string;
let projectId: string;
let owner: SignedIn;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Synthetic ULIDs: a fixed prefix and a counter in the last 6 characters. */
let seq = 0;
function batch(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, () => {
    let suffix = "";
    for (let v = seq++, i = 0; i < 6; i++, v = Math.floor(v / 32)) suffix = CROCKFORD[v % 32] + suffix;
    return ingestEvent({ event_id: `01JBQ4Z3H8X9T2K7M5N6${suffix}` });
  });
}

async function setup(config: Parameters<typeof harness>[0] = {}) {
  h = await harness(config);
  owner = await signIn(h, "owner@example.test");
  ({ key, projectId } = await projectWithKey(h, owner));
}

function ingest(body: unknown, app = h.app) {
  return app.inject({
    method: "POST",
    url: "/api/v1/ingest",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function rateHeaders(res: { headers: Record<string, unknown> }) {
  return {
    limit: res.headers["x-ratelimit-limit"],
    remaining: res.headers["x-ratelimit-remaining"],
    reset: res.headers["x-ratelimit-reset"],
  };
}

function dropped(): number {
  let total = 0;
  for (const c of h.metadata.counters.get(projectId)?.values() ?? []) total += c.dropped;
  return total;
}

describe("rate limit (429 rate_limited)", () => {
  beforeEach(() => setup({ config: { rateLimitPerMinute: 100 } }));

  it("admits exactly the limit in one minute and refuses limit + 1", async () => {
    // 09:15:00.000: 60 seconds until the window resets.
    const first = await ingest({ events: batch(100) });
    expect(first.statusCode).toBe(202);
    expect(rateHeaders(first)).toEqual({ limit: "100", remaining: "0", reset: "60" });

    const over = await ingest({ events: batch(1) });
    expect(over.statusCode).toBe(429);
    expect(over.headers["retry-after"]).toBe("60");
    expect(over.json()).toEqual({
      error: { code: "rate_limited", message: "project exceeded 100 events per minute", retry_after: 60 },
    });
    expect(rateHeaders(over)).toEqual({ limit: "100", remaining: "0", reset: "60" });
    expect(h.queue.jobs).toHaveLength(1);
  });

  it("refuses a request that would pass the limit and admits one that reaches it", async () => {
    expect((await ingest({ events: batch(99) })).statusCode).toBe(202);
    const over = await ingest({ events: batch(2) });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("rate_limited");
    expect(rateHeaders(over).remaining).toBe("1");
    const fits = await ingest({ events: batch(1) });
    expect(fits.statusCode).toBe(202);
    expect(rateHeaders(fits).remaining).toBe("0");
    // Rate-limited events are not dropped: the SDK retries them.
    expect(dropped()).toBe(0);
  });

  it("refuses before the body is parsed once the minute is used up", async () => {
    await ingest({ events: batch(100) });
    const res = await ingest("{ not json");
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
  });

  it("resets when the next minute starts", async () => {
    h.now.value = new Date("2026-11-05T09:15:45.200Z");
    await ingest({ events: batch(100) });
    const limited = await ingest({ events: batch(1) });
    expect(limited.headers["retry-after"]).toBe("15");
    expect(limited.json().error.retry_after).toBe(15);

    h.now.value = new Date("2026-11-05T09:16:00.000Z");
    const next = await ingest({ events: batch(1) });
    expect(next.statusCode).toBe(202);
    expect(rateHeaders(next)).toEqual({ limit: "100", remaining: "99", reset: "60" });
  });

  it("survives a restart: a new API process sees the same window", async () => {
    await ingest({ events: batch(100) });
    // A second app over the same storage, as after a restart or with two API processes.
    const restarted = await buildApp({
      metadata: h.metadata,
      events: h.events,
      queue: h.queue,
      limits: h.limits,
      hasher: fakeHasher,
      clock: () => h.now.value,
      config: { rateLimitPerMinute: 100 },
    });
    const res = await ingest({ events: batch(1) }, restarted);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
    await restarted.close();
  });

  it("uses the project's own limit over the instance default", async () => {
    h.limits.settings.set(projectId, { rateLimitPerMinute: 150, eventsPerDay: null });
    expect((await ingest({ events: batch(100) })).statusCode).toBe(202);
    const res = await ingest({ events: batch(50) });
    expect(res.statusCode).toBe(202);
    expect(rateHeaders(res)).toMatchObject({ limit: "150", remaining: "0" });
  });

  it("counts every event in the request, including rejected ones", async () => {
    const events = [...batch(98), { schema_version: 1 }];
    const res = await ingest({ events });
    expect(res.statusCode).toBe(202);
    expect(res.json().rejected).toHaveLength(1);
    expect(rateHeaders(res).remaining).toBe("1");
  });
});

describe("X-RateLimit-* headers", () => {
  beforeEach(() => setup());

  it("defaults to 1,000 events per minute", async () => {
    const res = await ingest({ events: batch(3) });
    expect(res.statusCode).toBe(202);
    expect(rateHeaders(res)).toEqual({ limit: "1000", remaining: "997", reset: "60" });
  });

  it.each([
    ["400", { events: [] }],
    ["400 too_many_events", { events: batch(101) }],
    ["400 invalid_json", "{"],
  ])("are sent on a %s response", async (_name, body) => {
    const res = await ingest(body);
    expect(res.statusCode).toBe(400);
    expect(rateHeaders(res)).toEqual({ limit: "1000", remaining: "1000", reset: "60" });
  });

  it("are sent on 403 and 415 responses", async () => {
    const res415 = await h.app.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { authorization: `Bearer ${key}`, "content-type": "text/plain" },
      payload: "x",
    });
    expect(res415.statusCode).toBe(415);
    expect(rateHeaders(res415).limit).toBe("1000");
    h.metadata.projects[0]!.disabled = true;
    const res403 = await ingest({ events: batch(1) });
    expect(res403.statusCode).toBe(403);
    expect(rateHeaders(res403).limit).toBe("1000");
  });

  it("are not sent on a 401, where no project is known", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ events: batch(1) }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  it("answer 503 when usage cannot be read", async () => {
    h.limits.failWith = new Error("database down");
    const res = await ingest({ events: batch(1) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: "unavailable", retry_after: 5 });
    expect(h.queue.jobs).toHaveLength(0);
  });
});

describe("daily quota (429 quota_exceeded)", () => {
  beforeEach(async () => {
    await setup();
    h.limits.settings.set(projectId, { rateLimitPerMinute: null, eventsPerDay: 150 });
  });

  it("admits the quota, refuses quota + 1 until midnight UTC, and counts the drop", async () => {
    expect((await ingest({ events: batch(100) })).statusCode).toBe(202);
    const over = await ingest({ events: batch(51) });
    expect(over.statusCode).toBe(429);
    // 09:15:00 to midnight UTC.
    expect(over.headers["retry-after"]).toBe(String(14 * 3600 + 45 * 60));
    expect(over.json()).toEqual({
      error: {
        code: "quota_exceeded",
        message: "project exceeded its quota of 150 events per day",
        retry_after: 14 * 3600 + 45 * 60,
      },
    });
    expect(h.queue.jobs).toHaveLength(1);
    expect(dropped()).toBe(51);

    expect((await ingest({ events: batch(50) })).statusCode).toBe(202);
    const after = await ingest({ events: batch(1) });
    expect(after.statusCode).toBe(429);
    expect(after.json().error.code).toBe("quota_exceeded");
    expect(h.queue.jobs).toHaveLength(2);
    expect(dropped()).toBe(52);
    expect([...h.metadata.counters.get(projectId)!.keys()]).toEqual(["2026-11-05"]);
  });

  it("opens again at midnight UTC", async () => {
    await ingest({ events: batch(100) });
    await ingest({ events: batch(50) });
    expect((await ingest({ events: batch(1) })).statusCode).toBe(429);
    h.now.value = new Date("2026-11-06T00:00:00.000Z");
    expect((await ingest({ events: batch(1) })).statusCode).toBe(202);
  });

  it("is checked before the rate limit, and refuses unread once the minute is also used up", async () => {
    h.limits.settings.set(projectId, { rateLimitPerMinute: 100, eventsPerDay: 100 });
    await ingest({ events: batch(100) });
    // Over quota with no room in the minute: quota_exceeded, body not read, nothing counted.
    const res = await ingest("{ not json");
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("quota_exceeded");
    expect(dropped()).toBe(0);
  });

  it("still applies the rate limit to a project over quota", async () => {
    h.limits.settings.set(projectId, { rateLimitPerMinute: 100, eventsPerDay: 10 });
    await ingest({ events: batch(10) });
    // Refused for quota; the 90 still count toward the minute.
    expect((await ingest({ events: batch(90) })).json().error.code).toBe("quota_exceeded");
    expect(dropped()).toBe(90);
    const unread = await ingest({ events: batch(5) });
    expect(unread.json().error.code).toBe("quota_exceeded");
    expect(dropped()).toBe(90);
  });

  it("takes the instance default when the project has none", async () => {
    await setup({ config: { quotaEventsPerDay: 5 } });
    expect((await ingest({ events: batch(5) })).statusCode).toBe(202);
    expect((await ingest({ events: batch(1) })).json().error.code).toBe("quota_exceeded");
  });

  it("still answers 429 when the dropped counter cannot be updated", async () => {
    await ingest({ events: batch(100) });
    h.metadata.incrementDailyCounters = async () => {
      throw new Error("counters down");
    };
    expect((await ingest({ events: batch(60) })).statusCode).toBe(429);
  });
});

describe("disk safety", () => {
  let free: number | Error;

  beforeEach(async () => {
    free = 50;
    const disk = new DiskMonitor({
      probe: async () => {
        if (free instanceof Error) throw free;
        return free;
      },
      cacheMs: 0,
    });
    await setup({ disk });
  });

  it.each([
    ["ok", 50],
    ["warn", 15],
    ["critical", 8],
  ])("accepts events at the %s level", async (_level, percent) => {
    free = percent;
    expect((await ingest({ events: batch(1) })).statusCode).toBe(202);
  });

  it("returns 503 unavailable with Retry-After: 60 at the full level", async () => {
    free = 5;
    const res = await ingest({ events: batch(1) });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.json()).toEqual({
      error: { code: "unavailable", message: "the server is low on disk space; retry later", retry_after: 60 },
    });
    expect(h.queue.jobs).toHaveLength(0);
  });

  it("fails closed when free space cannot be determined", async () => {
    free = new Error("statfs failed");
    const res = await ingest({ events: batch(1) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.retry_after).toBe(60);
  });

  it("keeps the dashboard API working when the disk is full", async () => {
    free = 1;
    const res = await h.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
  });
});

describe("project limits endpoints", () => {
  beforeEach(() => setup({ config: { rateLimitPerMinute: 500, quotaEventsPerDay: 1_000_000 } }));

  const url = () => `/api/v1/projects/${projectId}/limits`;

  it("shows members the settings and the effective values", async () => {
    const res = await h.app.inject({ method: "GET", url: url(), headers: owner.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      limits: {
        settings: { rate_limit_per_minute: null, events_per_day: null },
        effective: { rate_limit_per_minute: 500, events_per_day: 1_000_000 },
      },
    });
  });

  it("lets only instance admins change them", async () => {
    const payload = { rate_limit_per_minute: 2000, events_per_day: null };
    const denied = await h.app.inject({ method: "PUT", url: url(), headers: owner.headers, payload });
    expect(denied.statusCode).toBe(403);

    const admin = await signIn(h, "admin@example.test", "admin");
    const res = await h.app.inject({ method: "PUT", url: url(), headers: admin.headers, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().limits).toEqual({
      settings: { rate_limit_per_minute: 2000, events_per_day: null },
      effective: { rate_limit_per_minute: 2000, events_per_day: 1_000_000 },
    });
    expect(h.metadata.audit.at(-1)).toMatchObject({
      action: "project.ingest_limits_updated",
      projectId,
      viaInstanceAdmin: true,
      details: { rate_limit_per_minute: 2000, events_per_day: null },
    });
    expect(rateHeaders(await ingest({ events: batch(1) })).limit).toBe("2000");
  });

  it.each([
    [{ rate_limit_per_minute: 99, events_per_day: null }],
    [{ rate_limit_per_minute: null, events_per_day: 0 }],
    [{ rate_limit_per_minute: 1000 }],
    [{ rate_limit_per_minute: "1000", events_per_day: null }],
  ])("rejects %o", async (payload) => {
    const admin = await signIn(h, "admin@example.test", "admin");
    const res = await h.app.inject({ method: "PUT", url: url(), headers: admin.headers, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("hides another project's limits", async () => {
    const outsider = await signIn(h, "outsider@example.test");
    const res = await h.app.inject({ method: "GET", url: url(), headers: outsider.headers });
    expect(res.statusCode).toBe(404);
  });
});
