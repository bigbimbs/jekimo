import { expect, it, vi } from "vitest";
import { harness } from "./helpers.js";

it("records nested concurrent spans with monotonic durations and preserves outcomes", async () => {
  const h = harness();
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const root = h.client.startSpan({ name: "GET /reports", operation: "http.server" });
  const failure = new Error("synthetic-private-error");
  await root.run(async () => {
    clock.mockReturnValue(110);
    const child = h.client.withSpan({ name: "report.build" }, async () => {
      await Promise.resolve();
      h.client.log("info", "building");
      return { ok: true };
    });
    clock.mockReturnValue(120);
    await expect(
      h.client.withSpan({ name: "report.fail" }, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(child).resolves.toEqual({ ok: true });
  });
  clock.mockReturnValue(150);
  root.end();
  root.end("error");
  clock.mockRestore();
  expect(h.client.getTraceContext()).toBeUndefined();
  await h.client.close();
  const all = h.requests.flatMap((r) => r.body.events);
  const spans = all.filter((e) => e.context?.span_type === "span");
  expect(spans).toHaveLength(3);
  expect(spans.find((e) => e.message === "GET /reports")?.context).toMatchObject({
    span_duration_ms: "50",
    span_status: "ok",
    span_operation: "http.server",
  });
  for (const child of spans.filter((e) => e.message !== "GET /reports")) {
    expect(child.context?.trace_id).toBe(root.context.traceId);
    expect(child.context?.parent_span_id).toBe(root.context.spanId);
  }
  const build = spans.find((e) => e.message === "report.build");
  expect(all.find((e) => e.message === "building")?.context?.span_id).toBe(build?.context?.span_id);
  expect(spans.find((e) => e.message === "report.fail")?.context?.span_status).toBe("error");
  expect(JSON.stringify(all)).not.toContain("synthetic-private-error");
  expect(h.errors).toEqual([]);
});

it("keeps timing context subject to privacy, sampling and bounded queues", async () => {
  const hidden = harness({ captureContext: false });
  const redacted = harness({ redactKeys: ["span_duration_ms"] });
  const sampled = harness({ sampleRate: 0 });
  const bounded = harness({ maxQueueSize: 1 });
  for (const h of [hidden, redacted, sampled, bounded]) {
    await h.client.withSpan({ name: "first" }, () => 1);
    await h.client.withSpan({ name: "second" }, () => 2);
    await h.client.close();
  }
  expect(hidden.requests[0]?.body.events.every((e) => !e.context)).toBe(true);
  expect(redacted.requests[0]?.body.events[0]?.context?.span_duration_ms).toBe("[REDACTED]");
  expect(sampled.requests).toHaveLength(0);
  expect(bounded.requests[0]?.body.events).toHaveLength(1);
});
