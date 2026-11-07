import { INGEST_PATH } from "@jekimo/event-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init, SDK_VERSION } from "../src/index.js";
import { GZIP_THRESHOLD_BYTES, parseRetryAfter, retryDelay } from "../src/transport.js";
import { acceptAll, BASE_URL, type Harness, harness, KEY, response, SECRET, tick } from "./helpers.js";

let h: Harness;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await h?.client.close(0);
});

const filler = (n: number) => ({ filler: "x".repeat(n) });

describe("request format", () => {
  it("posts to the ingest path with the protocol headers", async () => {
    h = harness();
    h.client.log("info", "hello");
    await h.client.flush();
    const [req] = h.requests;
    expect(req!.url).toBe(`${BASE_URL}${INGEST_PATH}`);
    expect(req!.request.method).toBe("POST");
    expect(req!.request.redirect).toBe("manual");
    expect(req!.request.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "User-Agent": `@jekimo/sdk-node/${SDK_VERSION}`,
    });
    expect(Date.parse(req!.body.sent_at!)).not.toBeNaN();
    expect(req!.body.events).toHaveLength(1);
  });

  it("parses a DSN, keeps a path prefix, and keeps the key out of the URL", async () => {
    // dsn takes precedence over baseUrl and ingestionKey.
    h = harness({ dsn: `https://${KEY}@jekimo.example.com/observability/` });
    h.client.log("info", "hello");
    await h.client.flush();
    expect(h.requests[0]!.url).toBe(`https://jekimo.example.com/observability${INGEST_PATH}`);
    expect(h.requests[0]!.request.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it.each([
    [{ dsn: "not a url" }, "dsn is not a valid URL"],
    [{ dsn: `https://${KEY}:extra@jekimo.example.com` }, "dsn must have the form"],
    [{ baseUrl: BASE_URL, ingestionKey: "jk_bad" }, "malformed"],
    [{ baseUrl: BASE_URL }, "malformed"],
    [{ baseUrl: `https://user:pw@jekimo.example.com`, ingestionKey: KEY }, "must not contain credentials"],
    [{ baseUrl: "ftp://jekimo.example.com", ingestionKey: KEY }, "must use https"],
    [{}, "set dsn"],
  ])("disables the client for unusable configuration %#", (options, message) => {
    const errors: string[] = [];
    const client = init({
      transport: async () => response(202),
      onError: (e) => errors.push(`${e.code}: ${e.message}`),
      ...options,
    });
    expect(client.enabled).toBe(false);
    expect(client.log("info", "x")).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("invalid_config");
    expect(errors[0]).toContain(message);
    expect(errors[0]).not.toContain(SECRET);
  });

  it("warns about plain http to a non-loopback host but allows loopback", () => {
    const codes: string[] = [];
    const onError = (e: { code: string }) => codes.push(e.code);
    init({ baseUrl: "http://jekimo.internal:8080", ingestionKey: KEY, onError, flushOnExit: false });
    init({ baseUrl: "http://localhost:8080", ingestionKey: KEY, onError, flushOnExit: false });
    init({ baseUrl: "http://127.0.0.1:8080", ingestionKey: KEY, onError, flushOnExit: false });
    expect(codes).toEqual(["insecure_transport"]);
  });
});

describe("queue", () => {
  it("never calls the transport on the caller's stack", () => {
    h = harness();
    for (let i = 0; i < 150; i++) h.client.log("info", `e${i}`);
    expect(h.requests).toHaveLength(0);
  });

  it("drops the oldest event when full", async () => {
    h = harness({ maxQueueSize: 3, flushIntervalMs: 60_000 });
    const ids = [1, 2, 3, 4, 5].map((i) => h.client.log("info", `e${i}`));
    expect(h.drops).toEqual([
      { reason: "queue_full", count: 1 },
      { reason: "queue_full", count: 1 },
    ]);
    expect(h.client.stats()).toMatchObject({ queued: 3, dropped: 2 });
    await h.client.flush();
    expect(h.requests[0]!.body.events.map((e) => e.event_id)).toEqual(ids.slice(2));
    expect(h.client.stats()).toMatchObject({ queued: 0, sent: 3 });
  });

  it("uses the spec defaults", async () => {
    const { DEFAULTS } = await import("../src/client.js");
    expect(DEFAULTS).toEqual({
      maxQueueSize: 1000,
      flushIntervalMs: 2000,
      maxBatchEvents: 100,
      maxBatchBytes: 512 * 1024,
      shutdownTimeoutMs: 2000,
    });
  });
});

describe("flush triggers", () => {
  it("sends after the flush interval", async () => {
    vi.useFakeTimers();
    h = harness();
    h.client.log("info", "one");
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.requests).toHaveLength(1);
  });

  it("honours a custom flush interval", async () => {
    vi.useFakeTimers();
    h = harness({ flushIntervalMs: 500 });
    h.client.log("info", "one");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.requests).toHaveLength(1);
  });

  it("sends as soon as 100 events are queued", async () => {
    h = harness({ flushIntervalMs: 60_000 });
    for (let i = 0; i < 99; i++) h.client.log("info", `e${i}`);
    await tick(20);
    expect(h.requests).toHaveLength(0);
    h.client.log("info", "e99");
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.requests[0]!.body.events).toHaveLength(100);
  });

  it("sends as soon as 512 KiB of events are queued", async () => {
    h = harness({ flushIntervalMs: 60_000 });
    // About 65 KiB per event: seven stay under 512 KiB, the eighth crosses it.
    const attrs = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, "y".repeat(1024)]));
    for (let i = 0; i < 7; i++) h.client.log("info", `e${i}`, attrs);
    await tick(20);
    expect(h.requests).toHaveLength(0);
    h.client.log("info", "e7", attrs);
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    expect(h.requests[0]!.body.events).toHaveLength(7);
    expect(h.requests[1]!.body.events).toHaveLength(1);
  });

  it("flush() resolves false when it cannot finish in time", async () => {
    h = harness({}, () => new Promise(() => {}));
    h.client.log("info", "stuck");
    expect(await h.client.flush(30)).toBe(false);
  });
});

describe("batching", () => {
  it("splits by event count", async () => {
    h = harness({ flushIntervalMs: 60_000 });
    for (let i = 0; i < 250; i++) h.client.log("info", `e${i}`);
    expect(await h.client.flush()).toBe(true);
    expect(h.requests.map((r) => r.body.events.length)).toEqual([100, 100, 50]);
  });

  it("splits by bytes with a custom maxBatchBytes", async () => {
    h = harness({ flushIntervalMs: 60_000, maxBatchBytes: 4096 });
    for (let i = 0; i < 10; i++) h.client.log("info", `e${i}`, filler(1000));
    await h.client.flush();
    expect(h.requests.length).toBeGreaterThan(2);
    for (const r of h.requests) {
      const eventsBytes = r.body.events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0);
      expect(eventsBytes).toBeLessThanOrEqual(4096);
    }
    expect(h.requests.flatMap((r) => r.body.events)).toHaveLength(10);
  });

  it("clamps maxBatchEvents to the protocol limit", async () => {
    h = harness({ flushIntervalMs: 60_000, maxBatchEvents: 500 });
    for (let i = 0; i < 150; i++) h.client.log("info", `e${i}`);
    await h.client.flush();
    expect(h.requests.map((r) => r.body.events.length)).toEqual([100, 50]);
  });
});

describe("compression", () => {
  it("does not compress bodies at or below 8 KiB", async () => {
    h = harness();
    h.client.log("info", "small", filler(100));
    await h.client.flush();
    const req = h.requests[0]!;
    expect(typeof req.request.body).toBe("string");
    expect(req.request.headers["Content-Encoding"]).toBeUndefined();
    expect(req.wireBytes).toBeLessThanOrEqual(GZIP_THRESHOLD_BYTES);
  });

  it("gzips bodies above 8 KiB", async () => {
    h = harness();
    h.client.log("info", "big", filler(1000));
    for (let i = 0; i < 9; i++) h.client.log("info", `big${i}`, filler(1000));
    await h.client.flush();
    const req = h.requests[0]!;
    expect(req.request.headers["Content-Encoding"]).toBe("gzip");
    expect(req.request.body).toBeInstanceOf(Uint8Array);
    expect(req.body.events).toHaveLength(10);
    expect(req.wireBytes).toBeLessThan(GZIP_THRESHOLD_BYTES);
  });
});

describe("retry policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  it("backs off exponentially with full jitter and gives up after 5 attempts", async () => {
    h = harness({}, () => response(503, { error: { code: "unavailable", message: "down" } }));
    h.client.log("info", "x");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.requests).toHaveLength(5);
    const gaps = h.requests.slice(1).map((r, i) => r.at - h.requests[i]!.at);
    // random() = 0.5 of min(60 s, 1 s × 2^(n−1))
    expect(gaps).toEqual([500, 1000, 2000, 4000]);
    expect(h.errors.map((e) => e.code)).toEqual(["retries_exhausted"]);
    expect(h.errors[0]).toMatchObject({ status: 503, serverCode: "unavailable" });
    expect(h.drops).toEqual([{ reason: "retries_exhausted", count: 1 }]);
  });

  it("computes jittered delays capped at 60 seconds", () => {
    expect(retryDelay(1, undefined, () => 0.999)).toBe(999);
    expect(retryDelay(4, undefined, () => 0.999)).toBe(7992);
    expect(retryDelay(7, undefined, () => 0.999)).toBe(59_940);
    expect(retryDelay(20, undefined, () => 0.999)).toBe(59_940);
    expect(retryDelay(3, undefined, () => 0)).toBe(0);
    expect(retryDelay(3, 12_000, () => 0.999)).toBe(12_000);
  });

  it.each([429, 500, 502, 503, 504])("retries status %i", async (status) => {
    h = harness({}, (_req, i) => (i === 0 ? response(status) : acceptAll(_req)));
    h.client.log("info", "x");
    await vi.advanceTimersByTimeAsync(2000 + 500);
    expect(h.requests).toHaveLength(2);
    expect(h.client.stats().sent).toBe(1);
    expect(h.errors).toEqual([]);
  });

  it("retries network errors", async () => {
    h = harness({}, (req, i) => {
      if (i === 0) throw new TypeError("fetch failed");
      return acceptAll(req);
    });
    h.client.log("info", "x");
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.requests).toHaveLength(2);
    expect(h.debugLines.some((l) => l.includes("network error: fetch failed"))).toBe(true);
  });

  it("waits exactly Retry-After seconds when the header is present", async () => {
    h = harness({}, (req, i) =>
      i === 0
        ? response(
            429,
            { error: { code: "rate_limited", message: "slow down", retry_after: 99 } },
            { "Retry-After": "7" },
          )
        : acceptAll(req),
    );
    h.client.log("info", "x");
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(6999);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.at - h.requests[0]!.at).toBe(7000);
  });

  it("falls back to error.retry_after in the body", async () => {
    h = harness({}, (req, i) =>
      i === 0 ? response(503, { error: { code: "unavailable", message: "x", retry_after: 3 } }) : acceptAll(req),
    );
    h.client.log("info", "x");
    await vi.advanceTimersByTimeAsync(2000 + 3000);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.at - h.requests[0]!.at).toBe(3000);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    const now = Date.parse("2026-11-05T09:00:00Z");
    expect(parseRetryAfter("12", now)).toBe(12_000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("Thu, 05 Nov 2026 09:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Thu, 05 Nov 2026 08:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it.each([
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "project_disabled"],
    [413, "payload_too_large"],
    [415, "unsupported_media_type"],
    [404, undefined],
    [301, undefined],
  ])("does not retry %i and reports it once", async (status, code) => {
    h = harness({}, () => response(status, code ? { error: { code, message: "no" } } : "Not here"));
    h.client.log("info", "a");
    await vi.advanceTimersByTimeAsync(2000);
    h.client.log("info", "b");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.requests).toHaveLength(2);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ code: "request_failed", status, ...(code ? { serverCode: code } : {}) });
    expect(h.drops).toEqual([
      { reason: "request_failed", count: 1 },
      { reason: "request_failed", count: 1 },
    ]);
  });
});

describe("202 handling", () => {
  it("logs rejected events through onError and never resends them", async () => {
    vi.useFakeTimers();
    h = harness({}, (req) =>
      response(202, {
        accepted: [req.body.events[0]!.event_id],
        rejected: [
          {
            index: 1,
            event_id: req.body.events[1]!.event_id,
            errors: [{ path: "/message", code: "max_length", message: "/message must be at most 4096 characters" }],
          },
        ],
        warnings: [{ index: 0, path: "/future_field", code: "unknown_field", message: "dropped" }],
      }),
    );
    h.client.log("info", "ok");
    const rejectedId = h.client.log("info", "bad");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.requests).toHaveLength(1);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({
      code: "event_rejected",
      eventId: rejectedId,
      issues: [{ path: "/message", code: "max_length" }],
    });
    expect(h.client.stats()).toMatchObject({ sent: 1, rejected: 1, queued: 0 });
    expect(h.debugLines.some((l) => l.includes("server warning"))).toBe(true);
  });

  it("treats a 2xx without a body as success", async () => {
    h = harness({}, () => response(202));
    h.client.log("info", "x");
    await h.client.flush();
    expect(h.client.stats().sent).toBe(1);
    expect(h.errors).toEqual([]);
  });
});

describe("close", () => {
  it("aborts a stuck request and drops what is left", async () => {
    let aborted = false;
    h = harness(
      {},
      (req) =>
        new Promise((_resolve, reject) => {
          req.request.signal.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    h.client.log("info", "a");
    h.client.log("info", "b");
    void h.client.flush();
    await tick(5);
    expect(await h.client.close(20)).toBe(false);
    expect(aborted).toBe(true);
    expect(h.drops).toEqual([{ reason: "shutdown", count: 2 }]);
    expect(h.client.enabled).toBe(false);
  });

  it("does not wait out a retry backoff", async () => {
    h = harness({}, () => response(429, undefined, { "Retry-After": "3600" }));
    h.client.log("info", "a");
    await h.client.flush(20);
    const started = Date.now();
    await h.client.close(20);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(h.drops).toEqual([{ reason: "shutdown", count: 1 }]);
  });
});

describe("the ingestion key", () => {
  it("never appears in debug output or error messages", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const sink = (line: string) => lines.push(line);
    const responses = [
      () => Promise.reject(new TypeError(`connect failed for ${KEY}`)),
      () => response(503, { error: { code: "unavailable", message: `echo ${SECRET}` } }),
      () => response(401, { error: { code: "unauthorized", message: "bad key" } }),
      () =>
        response(202, {
          accepted: [],
          rejected: [{ index: 0, errors: [{ path: "", code: "type", message: `about ${KEY}` }] }],
        }),
    ];
    h = harness({ debug: sink, onError: (e) => lines.push(JSON.stringify(e)) }, (_req, i) =>
      responses[Math.min(i, 3)]!(),
    );
    h.client.log("info", "one");
    await vi.advanceTimersByTimeAsync(120_000);
    h.client.log("info", "two");
    await vi.advanceTimersByTimeAsync(120_000);
    await h.client.close(0);

    const dsnLines: string[] = [];
    const viaDsn = init({
      dsn: `https://${KEY}@jekimo.example.com`,
      debug: (l) => dsnLines.push(l),
      transport: async () => response(202),
      flushOnExit: false,
    });
    await viaDsn.close(0);

    const all = [...lines, ...dsnLines].join("\n");
    expect(lines.length).toBeGreaterThan(5);
    expect(all).toContain("jekimo.example.com");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(KEY);
  });

  it("is not logged to the console by default debug output", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = init({
      dsn: `https://${KEY}@jekimo.example.com`,
      debug: true,
      flushOnExit: false,
      transport: async () => response(401),
    });
    client.log("info", "x");
    await client.flush();
    await client.close(0);
    const output = [...debug.mock.calls, ...warn.mock.calls].flat().join("\n");
    expect(debug).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(output).not.toContain(SECRET);
  });
});
