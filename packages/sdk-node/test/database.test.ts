import { expect, it, vi } from "vitest";
import { harness } from "./helpers.js";

const options = { name: "invoices.list", system: "postgresql", operation: "select" } as const;
it("measures success and failure without sending results, SQL, or exceptions", async () => {
  const h = harness();
  const result = { secret: "synthetic-result" };
  const error = new Error("synthetic-private-error");
  expect(await h.client.traceQuery(options, () => result)).toBe(result);
  await expect(
    h.client.traceQuery(options, () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(h.requests).toHaveLength(0);
  await h.client.close();
  const records = h.requests.flatMap((r) => r.body.events);
  expect(records.map((r) => r.database?.status)).toEqual(["ok", "error"]);
  expect(records.every((r) => r.database && r.database.duration_ms >= 0)).toBe(true);
  expect(JSON.stringify(records)).not.toContain("synthetic-private");
  expect(JSON.stringify(records)).not.toContain("synthetic-result");
});
it("preserves execution when reporting fails or is disabled", async () => {
  const h = harness();
  vi.spyOn(h.client, "captureQuery").mockImplementation(() => {
    throw Error("reporting failed");
  });
  expect(await h.client.traceQuery(options, async () => 42)).toBe(42);
  const failure = { synthetic: "failure" };
  await expect(
    h.client.traceQuery(options, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  await h.client.close();
  expect(await h.client.traceQuery(options, () => 7)).toBe(7);
});
it("rejects invalid timings, bounds the queue, and excludes extra properties", async () => {
  const h = harness({ maxQueueSize: 2 });
  expect(h.client.captureQuery({ ...options, status: "ok", duration_ms: -1 })).toBeUndefined();
  for (let n = 0; n < 3; n++)
    h.client.captureQuery({ ...options, status: "ok", duration_ms: n, statement: "synthetic SQL" } as Parameters<
      typeof h.client.captureQuery
    >[0]);
  expect(h.client.stats().queued).toBe(2);
  await h.client.close();
  expect(JSON.stringify(h.requests)).not.toContain("synthetic SQL");
});
