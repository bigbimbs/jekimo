import { expect, it, vi } from "vitest";
import { createFastifyTracingHooks, createPrismaTracingExtension } from "../src/index.js";
import { harness } from "./helpers.js";

it("completes timed-out and aborted requests once, and skips unmatched routes", async () => {
  const h = harness();
  const hooks = createFastifyTracingHooks(h.client);
  for (const aborted of [false, true]) {
    const request = { method: "POST", routeOptions: { url: "/tasks/:id" } };
    hooks.onRequest(request, { statusCode: 200 }, () => {});
    if (aborted) hooks.onRequestAbort(request, () => {});
    else hooks.onTimeout(request, { statusCode: 200 }, () => {});
    hooks.onResponse(request, { statusCode: 200 }, () => {});
  }
  hooks.onRequest({ method: "GET", routeOptions: {} }, { statusCode: 404 }, () => {});
  await h.client.close();
  const spans = h.requests.flatMap((r) => r.body.events);
  expect(spans).toHaveLength(2);
  expect(spans.every((e) => e.context?.span_status === "error")).toBe(true);
});

it("Prisma extension preserves model query arguments, results and errors without capturing them", async () => {
  const h = harness();
  const extension = createPrismaTracingExtension({ client: h.client, system: "postgresql" });
  const query = extension.query.$allModels.$allOperations;
  const args = { where: { email: "private@example.test" } },
    result = [{ token: "synthetic-private-result" }];
  const original = vi.fn(async (input: typeof args) => {
    expect(input).toBe(args);
    return result;
  });
  await h.client.withSpan({ name: "GET /users" }, async () => {
    await expect(query({ model: "User", operation: "findMany", args, query: original })).resolves.toBe(result);
    const error = new Error("synthetic-private-error");
    await expect(
      query({
        model: "User",
        operation: "update",
        args,
        query: () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });
  await h.client.close();
  const events = h.requests.flatMap((r) => r.body.events);
  const root = events.find((e) => e.context?.span_type === "span");
  const calls = events.filter((e) => e.database);
  expect(calls.map((e) => e.database)).toMatchObject([
    { name: "User.findMany", operation: "select", status: "ok" },
    { name: "User.update", operation: "update", status: "error" },
  ]);
  expect(calls.every((e) => e.context?.parent_span_id === root?.context?.span_id)).toBe(true);
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain("private@example.test");
  expect(serialized).not.toContain("synthetic-private");
  expect(original).toHaveBeenCalledTimes(1);
});
