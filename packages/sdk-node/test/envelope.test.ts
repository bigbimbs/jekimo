import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type EventEnvelope, LIMITS, REDACTED_VALUE, ULID_PATTERN, validateEvent } from "@jekimo/event-schema";
import { afterEach, describe, expect, it } from "vitest";
import { byteLength, CIRCULAR_VALUE, fitEvent, TRUNCATED_VALUE, truncate } from "../src/envelope.js";
import { SDK_NAME, SDK_VERSION } from "../src/index.js";
import { type Harness, harness } from "./helpers.js";

const examplesDir = join(import.meta.dirname, "../../event-schema/examples");
function example(name: string): EventEnvelope {
  return JSON.parse(readFileSync(join(examplesDir, name), "utf8")) as EventEnvelope;
}

/** The ingest form of an example: no project_id, and the fields the SDK always generates removed. */
function comparable(event: EventEnvelope): Record<string, unknown> {
  const { project_id: _p, event_id: _e, timestamp: _t, ...rest } = event;
  return rest;
}

let h: Harness;
afterEach(async () => {
  await h?.client.close(0);
});

async function captured(): Promise<EventEnvelope[]> {
  await h.client.flush();
  return h.requests.flatMap((r) => r.body.events);
}

async function one(): Promise<EventEnvelope> {
  const events = await captured();
  expect(events).toHaveLength(1);
  return events[0]!;
}

describe("envelope shape", () => {
  it("builds the exception example from an Error", async () => {
    const ex = example("exception.json");
    h = harness({ service: ex.service!, environment: ex.environment!, release: ex.release!, captureContext: true });
    class DatabaseError extends Error {
      override name = "DatabaseError";
    }
    const error = new DatabaseError(ex.exception!.value!);
    error.stack = ex.exception!.stacktrace!;
    h.client.captureException(error, {
      message: ex.message,
      fingerprint: ex.fingerprint!,
      context: ex.context!,
      attributes: ex.attributes!,
    });
    const event = await one();
    expect(event.event_id).toMatch(ULID_PATTERN);
    expect(Date.parse(event.timestamp)).not.toBeNaN();
    const { runtime, ...context } = event.context!;
    expect(runtime).toBe(`node/${process.versions.node}`);
    expect(comparable({ ...event, context })).toEqual({
      ...comparable(ex),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
    });
    expect(validateEvent(event, { mode: "ingest" }).ok).toBe(true);
  });

  it("builds the log example with log()", async () => {
    const ex = example("log.json");
    h = harness({
      service: ex.service!,
      environment: ex.environment!,
      release: ex.release!,
      context: ex.context!,
      captureContext: true,
    });
    h.client.log(ex.severity, ex.message, ex.attributes!);
    const event = await one();
    const { runtime: _r, ...context } = event.context!;
    expect(comparable({ ...event, context })).toEqual({
      ...comparable(ex),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
    });
  });

  it("builds the custom event example with captureEvent()", async () => {
    const ex = example("custom-event.json");
    h = harness({ service: ex.service!, environment: ex.environment!, captureContext: false });
    h.client.captureEvent({
      kind: ex.kind,
      severity: ex.severity,
      message: ex.message,
      timestamp: ex.timestamp,
      attributes: ex.attributes!,
    });
    const event = await one();
    expect(event.timestamp).toBe(ex.timestamp);
    expect(comparable(event)).toEqual({ ...comparable(ex), sdk: { name: SDK_NAME, version: SDK_VERSION } });
  });

  it("uses kind event and severity info for captureMessage by default", async () => {
    h = harness();
    h.client.captureMessage("Deploy finished");
    const event = await one();
    expect(event).toMatchObject({ kind: "event", severity: "info", message: "Deploy finished" });
  });

  it("flattens cause chains into the stacktrace", async () => {
    h = harness();
    const root = new RangeError("socket closed");
    const middle = new TypeError("query failed", { cause: root });
    const top = new Error("charge failed", { cause: middle });
    h.client.captureException(top);
    const event = await one();
    expect(event.exception!.type).toBe("Error");
    expect(event.exception!.value).toBe("charge failed");
    const st = event.exception!.stacktrace!;
    expect(st.startsWith("Error: charge failed\n")).toBe(true);
    expect(st).toContain("\nCaused by: TypeError: query failed\n");
    expect(st).toContain("\nCaused by: RangeError: socket closed\n");
    expect(st.indexOf("TypeError")).toBeLessThan(st.indexOf("RangeError"));
  });

  it("stops at a circular cause", async () => {
    h = harness();
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause: unknown }).cause = b;
    h.client.captureException(a);
    const event = await one();
    expect(event.exception!.stacktrace).toContain("Caused by: [Circular]");
  });

  it("includes AggregateError members", async () => {
    h = harness();
    h.client.captureException(new AggregateError([new Error("first"), "second"], "both failed"));
    const st = (await one()).exception!.stacktrace!;
    expect(st).toContain("[errors][0]: Error: first");
    expect(st).toContain("[errors][1]: second");
  });

  it("captures thrown non-error values", async () => {
    h = harness();
    h.client.captureException("plain string");
    h.client.captureException({ code: 42 });
    const [a, b] = await captured();
    expect(a!.exception).toEqual({ type: "NonError", value: "plain string" });
    expect(a!.message).toBe("plain string");
    expect(b!.exception).toEqual({ type: "NonError", value: '{"code":42}' });
  });

  it("uses the error type as message when the error message is empty", async () => {
    h = harness();
    h.client.captureException(new TypeError(""));
    expect((await one()).message).toBe("TypeError");
  });

  it("returns the event id and queues nothing when disabled", async () => {
    h = harness();
    const id = h.client.log("info", "x");
    expect(id).toMatch(ULID_PATTERN);
    await h.client.close();
    expect(h.client.log("info", "y")).toBeUndefined();
    expect(h.client.enabled).toBe(false);
  });
});

describe("redaction", () => {
  it("redacts default keys at every depth in attributes, including inside arrays", async () => {
    h = harness();
    h.client.log("info", "login", {
      Password: "synthetic-pass",
      user: { profile: { "API-Key": "synthetic-key", name: "ok" } },
      sessions: [{ session_id: "s1" }, { refresh_token: "t1", kept: true }],
      "set-cookie": "a=b",
      "Credit Card": "4111",
    });
    const event = await one();
    expect(event.attributes).toEqual({
      Password: REDACTED_VALUE,
      user: { profile: { "API-Key": REDACTED_VALUE, name: "ok" } },
      sessions: [{ session_id: REDACTED_VALUE }, { refresh_token: REDACTED_VALUE, kept: true }],
      "set-cookie": REDACTED_VALUE,
      "Credit Card": REDACTED_VALUE,
    });
    expect(JSON.stringify(h.requests[0]!.body)).not.toContain("synthetic-");
  });

  it("redacts a whole object value when its key matches", async () => {
    h = harness();
    h.client.log("info", "x", { secret: { nested: "value" } });
    expect((await one()).attributes).toEqual({ secret: REDACTED_VALUE });
  });

  it("redacts context keys", async () => {
    h = harness({ context: { authorization: "Bearer synthetic" } });
    h.client.captureMessage("x", "info", { context: { request_id: "req_1", Cookie: "c=1" } });
    const event = await one();
    expect(event.context).toMatchObject({ authorization: REDACTED_VALUE, Cookie: REDACTED_VALUE, request_id: "req_1" });
  });

  it("adds operator keys and regular expressions to the defaults", async () => {
    h = harness({ redactKeys: ["Internal-Note"], redactPatterns: [/^x-/i, /pin$/g] });
    h.client.log("info", "x", {
      internal_note: "n",
      "X-Tenant": "t",
      account_pin: "1",
      pinned: "kept",
      nested: { "x-other": "o" },
    });
    h.client.log("info", "y", { account_pin: "2" });
    const [a, b] = await captured();
    expect(a!.attributes).toEqual({
      internal_note: REDACTED_VALUE,
      "X-Tenant": REDACTED_VALUE,
      account_pin: REDACTED_VALUE,
      pinned: "kept",
      nested: { "x-other": REDACTED_VALUE },
    });
    // A global expression keeps lastIndex between calls; it must still match.
    expect(b!.attributes).toEqual({ account_pin: REDACTED_VALUE });
  });

  it("sends no context when captureContext is false", async () => {
    h = harness({ captureContext: false, context: { host: "h" } });
    h.client.captureMessage("x", "info", { context: { request_id: "r" } });
    expect((await one()).context).toBeUndefined();
  });
});

describe("truncation and limits", () => {
  it("truncates with an ellipsis and never splits a surrogate pair", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 3)).toBe("abc");
    const emoji = "ab😀cd"; // the emoji is two code units at index 2-3
    expect(truncate(emoji, 4)).toBe("ab…");
    expect(truncate(emoji, 5)).toBe("ab😀…");
  });

  it("truncates message, exception fields, and short strings to their limits", async () => {
    h = harness({ service: "s".repeat(500), environment: "e".repeat(500), release: "r".repeat(500) });
    const error = new Error("v".repeat(10_000));
    error.name = "T".repeat(1000);
    error.stack = "S".repeat(100_000);
    h.client.captureException(error, { message: "m".repeat(10_000), fingerprint: "f".repeat(1000) });
    const event = await one();
    expect(event.message).toHaveLength(LIMITS.MAX_MESSAGE_CHARS);
    expect(event.message.endsWith("…")).toBe(true);
    expect(event.exception!.type).toHaveLength(LIMITS.MAX_EXCEPTION_TYPE_CHARS);
    expect(event.exception!.value).toHaveLength(LIMITS.MAX_EXCEPTION_VALUE_CHARS);
    expect(event.exception!.stacktrace).toHaveLength(LIMITS.MAX_STACKTRACE_CHARS);
    expect(event.service).toHaveLength(LIMITS.MAX_SHORT_STRING_CHARS);
    expect(event.environment).toHaveLength(LIMITS.MAX_SHORT_STRING_CHARS);
    expect(event.release).toHaveLength(LIMITS.MAX_SHORT_STRING_CHARS);
    expect(event.fingerprint).toHaveLength(LIMITS.MAX_FINGERPRINT_CHARS);
    expect(validateEvent(event, { mode: "ingest" }).ok).toBe(true);
  });

  it("caps context entries, key length, and value length", async () => {
    const context: Record<string, unknown> = {
      ["k".repeat(65)]: "dropped",
      long: "x".repeat(2000),
      num: 5,
      obj: { a: 1 },
    };
    for (let i = 0; i < 40; i++) context[`c${i}`] = "v";
    h = harness({ captureContext: true });
    h.client.captureMessage("x", "info", { context });
    const ctx = (await one()).context!;
    expect(Object.keys(ctx)).toHaveLength(LIMITS.MAX_CONTEXT_KEYS);
    expect(ctx["k".repeat(65)]).toBeUndefined();
    expect(ctx.long).toHaveLength(LIMITS.MAX_CONTEXT_VALUE_CHARS);
    expect(ctx.num).toBe("5");
    expect(ctx.obj).toBeUndefined();
  });

  it("caps attribute keys, key length, strings, arrays, and depth", async () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i++) wide[`a${i}`] = i;
    h = harness();
    h.client.log("info", "x", {
      wide,
      ["k".repeat(65)]: 1,
      text: "t".repeat(5000),
      list: Array.from({ length: 50 }, (_, i) => i),
      deep: { l3: { l4: { l5: { l6: 1 } } } },
      deepArray: [[[["x"]]]],
    });
    const attrs = (await one()).attributes!;
    expect(Object.keys(attrs.wide as object)).toHaveLength(LIMITS.MAX_ATTRIBUTE_KEYS);
    expect(attrs["k".repeat(65)]).toBeUndefined();
    expect(attrs.text).toHaveLength(LIMITS.MAX_ATTRIBUTE_STRING_CHARS);
    expect(attrs.list).toHaveLength(LIMITS.MAX_ATTRIBUTE_ARRAY_ITEMS);
    // attributes is depth 1, deep is 2, l3 is 3, l4 is 4; l4's value would be 5.
    expect(attrs.deep).toEqual({ l3: { l4: { l5: TRUNCATED_VALUE } } });
    expect(attrs.deepArray).toEqual([[[TRUNCATED_VALUE]]]);
  });

  it("caps the number of top-level attribute keys", async () => {
    const attributes: Record<string, number> = {};
    for (let i = 0; i < 70; i++) attributes[`a${i}`] = i;
    h = harness();
    h.client.log("info", "x", attributes);
    expect(Object.keys((await one()).attributes!)).toHaveLength(LIMITS.MAX_ATTRIBUTE_KEYS);
  });

  it("converts values JSON cannot carry", async () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    h = harness();
    h.client.log("info", "x", {
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      big: 10n,
      when: new Date("2026-01-02T03:04:05.000Z"),
      err: new RangeError("bad"),
      fn: () => 1,
      undef: undefined,
      sym: Symbol("s"),
      bytes: new Uint8Array(4),
      map: new Map([["a", 1]]),
      set: new Set([1, 2]),
      circular,
      sparse: [undefined, () => 1],
      json: { toJSON: () => ({ converted: true }) },
    });
    const attrs = (await one()).attributes!;
    expect(attrs).toEqual({
      nan: "NaN",
      inf: "Infinity",
      big: "10",
      when: "2026-01-02T03:04:05.000Z",
      err: "RangeError: bad",
      bytes: "[Binary 4 bytes]",
      map: { a: 1 },
      set: [1, 2],
      circular: { name: "loop", self: CIRCULAR_VALUE },
      sparse: [null, null],
      json: { converted: true },
    });
  });

  it("drops the largest attributes when the event exceeds 128 KiB", async () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 64; i++) big[`b${i}`] = "x".repeat(1024);
    const attributes: Record<string, unknown> = { keep: "small" };
    for (let i = 0; i < 3; i++) attributes[`blob${i}`] = big;
    h = harness();
    h.client.log("info", "x", attributes);
    const event = await one();
    expect(byteLength(JSON.stringify(event))).toBeLessThanOrEqual(LIMITS.MAX_EVENT_BYTES);
    expect(event.attributes!.keep).toBe("small");
    expect(Object.keys(event.attributes!).length).toBeLessThan(4);
  });

  it("shrinks the stacktrace, then context, then text fields when attributes are not enough", () => {
    // Control characters serialise as six bytes each, so the stacktrace alone can exceed the limit.
    const event: EventEnvelope = {
      schema_version: 1,
      event_id: "01JBQ4Z3H8X9T2K7M5N6P8R9SV",
      timestamp: "2026-11-05T09:14:33.412Z",
      kind: "exception",
      severity: "error",
      message: "m",
      exception: { type: "E", value: "v", stacktrace: "\u0001".repeat(LIMITS.MAX_STACKTRACE_CHARS) },
      context: { request_id: "r" },
    };
    const json = fitEvent(event);
    expect(byteLength(json)).toBeLessThanOrEqual(LIMITS.MAX_EVENT_BYTES);
    expect(event.exception!.stacktrace!.length).toBeLessThan(LIMITS.MAX_STACKTRACE_CHARS);
    expect(event.context).toEqual({ request_id: "r" });
    expect(JSON.parse(json)).toEqual(event);

    const tiny: EventEnvelope = {
      ...event,
      exception: { type: "E", value: "v".repeat(500), stacktrace: "s" },
      context: { a: "1" },
      message: "m".repeat(500),
    };
    fitEvent(tiny, 300);
    expect(tiny.context).toBeUndefined();
    expect(tiny.exception!.stacktrace).toBeUndefined();
    expect(byteLength(JSON.stringify(tiny))).toBeLessThanOrEqual(300);
  });

  it("reports and drops events that are still invalid", async () => {
    h = harness();
    expect(h.client.captureEvent({ message: "" })).toBeUndefined();
    expect(h.client.captureEvent({ message: "future", timestamp: new Date(Date.now() + 3_600_000) })).toBeUndefined();
    expect(h.errors.map((e) => e.code)).toEqual(["invalid_event", "invalid_event"]);
    expect(h.errors[0]!.issues![0]!.path).toBe("/message");
    expect(h.drops).toEqual([
      { reason: "invalid_event", count: 1 },
      { reason: "invalid_event", count: 1 },
    ]);
    expect(h.client.stats().queued).toBe(0);
  });
});

describe("sampling", () => {
  it("drops logs and events at rate 0 but always keeps exceptions and errors", async () => {
    h = harness({ sampleRate: 0 });
    expect(h.client.log("info", "dropped")).toBeUndefined();
    expect(h.client.captureMessage("dropped", "warning")).toBeUndefined();
    expect(h.client.log("error", "kept")).toBeDefined();
    expect(h.client.captureMessage("kept", "fatal")).toBeDefined();
    expect(h.client.captureException(new Error("kept"))).toBeDefined();
    expect(await captured()).toHaveLength(3);
  });
});
