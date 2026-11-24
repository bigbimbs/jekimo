import { expect, it } from "vitest";
import { harness } from "./helpers.js";

it("keeps concurrent request contexts isolated and restores the outer scope", async () => {
  const h = harness();
  let resume: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let firstId = "",
    secondId = "";
  const first = h.client.withTrace({ name: "GET /invoices" }, async (context) => {
    firstId = context.traceId;
    await gate;
    h.client.log("info", "first");
    await h.client.traceQuery({ name: "invoices.list", system: "postgresql", operation: "select" }, () => 1);
  });
  const second = h.client.withTrace({ name: "GET /customers" }, async (context) => {
    secondId = context.traceId;
    h.client.log("info", "second");
    resume();
  });
  await Promise.all([first, second]);
  expect(firstId).not.toBe(secondId);
  expect(h.client.getTraceContext()).toBeUndefined();
  h.client.log("info", "outside");
  await h.client.close();
  const events = h.requests.flatMap((r) => r.body.events);
  expect(events.find((e) => e.message === "first")?.context?.trace_id).toBe(firstId);
  expect(events.find((e) => e.message === "second")?.context?.trace_id).toBe(secondId);
  const query = events.find((e) => e.database);
  expect(query?.context?.trace_id).toBe(firstId);
  expect(query?.context?.parent_span_id).toBe(events.find((e) => e.message === "first")?.context?.span_id);
  expect(query?.context?.span_id).not.toBe(query?.context?.parent_span_id);
  expect(events.find((e) => e.message === "outside")?.context?.trace_id).toBeUndefined();
});
it("preserves values, promises, exceptions and nested trace parents", async () => {
  const h = harness();
  const value = { synthetic: true },
    promise = Promise.resolve(value);
  const error = new Error("synthetic");
  expect(h.client.withTrace({ name: "sync" }, () => value)).toBe(value);
  expect(h.client.withTrace({ name: "async" }, () => promise)).toBe(promise);
  expect(() =>
    h.client.withTrace({ name: "throw" }, () => {
      throw error;
    }),
  ).toThrow(error);
  expect(h.client.getTraceContext()).toBeUndefined();
  h.client.withTrace({ name: "outer", traceId: "1".repeat(32), parentSpanId: "2".repeat(16) }, (outer) => {
    expect(Object.isFrozen(outer)).toBe(true);
    h.client.withTrace({ name: "inner" }, (inner) => {
      expect(inner.traceId).toBe(outer.traceId);
      expect(inner.parentSpanId).toBe(outer.spanId);
    });
    expect(h.client.getTraceContext()?.spanId).toBe(outer.spanId);
  });
  h.client.withTrace({ name: "bad", traceId: "0".repeat(32), parentSpanId: "2".repeat(16) }, (ctx) => {
    expect(ctx.traceId).not.toBe("0".repeat(32));
    expect(ctx.parentSpanId).toBeUndefined();
  });
  await h.client.close();
});
it("keeps clients separate and honors context suppression and redaction", async () => {
  const a = harness(),
    b = harness({ captureContext: false }),
    c = harness({ redactKeys: ["trace_id"] });
  a.client.withTrace({ name: "first" }, () => {
    b.client.log("info", "other");
    expect(b.client.getTraceContext()).toBeUndefined();
  });
  b.client.withTrace({ name: "hidden" }, () => b.client.log("info", "hidden"));
  c.client.withTrace({ name: "redacted" }, () => c.client.log("info", "redacted"));
  await Promise.all([a.client.close(), b.client.close(), c.client.close()]);
  expect(b.requests.flatMap((r) => r.body.events).every((e) => e.context === undefined)).toBe(true);
  expect(c.requests[0]?.body.events[0]?.context?.trace_id).toBe("[REDACTED]");
});
