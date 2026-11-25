import { gunzipSync } from "node:zlib";
import fastify from "fastify";
import { expect, it } from "vitest";
import { createFastifyTracingHooks, type EventEnvelope, init } from "../../../packages/sdk-node/src/index.js";

it("Fastify hooks isolate real concurrent requests, use templates and report failed responses", async () => {
  const app = fastify();
  const events: EventEnvelope[] = [];
  const client = init({
    baseUrl: "https://jekimo.example.test",
    ingestionKey: "jk_01JBQ4Z3H8X9_wq7m2k9f4t8v1x3z6b5n8c2d7g4h1j5r",
    flushOnExit: false,
    transport: async (_url, request) => {
      const raw =
        typeof request.body === "string"
          ? request.body
          : (request.headers["Content-Encoding"] === "gzip"
              ? gunzipSync(request.body)
              : Buffer.from(request.body)
            ).toString("utf8");
      events.push(...JSON.parse(raw).events);
      return { status: 202, headers: { get: () => null }, text: async () => "" };
    },
  });
  const hooks = createFastifyTracingHooks(client);
  app.addHook("onRequest", hooks.onRequest);
  app.addHook("onResponse", hooks.onResponse);
  app.addHook("onTimeout", hooks.onTimeout);
  app.addHook("onRequestAbort", hooks.onRequestAbort);
  app.get("/reports/:id", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    client.log("info", "requested");
    return client.withSpan({ name: "report.build" }, async () => {
      await client.traceQuery({ name: "reports.find", system: "postgresql", operation: "select" }, () => 1);
      return { ok: true };
    });
  });
  app.get("/failed", async () => {
    throw new Error("private-error-message");
  });
  try {
    const responses = await Promise.all([
      app.inject("/reports/private-a?secret=synthetic"),
      app.inject("/reports/private-b"),
      app.inject("/failed"),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 500]);
    await client.flush();
    const requests = events.filter((e) => e.context?.span_operation === "http.server");
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((e) => e.context?.trace_id)).size).toBe(3);
    expect(requests.filter((e) => e.message === "GET /reports/:id")).toHaveLength(2);
    expect(requests.find((e) => e.message === "GET /failed")?.context?.span_status).toBe("error");
    for (const root of requests.filter((e) => e.message === "GET /reports/:id")) {
      const correlated = events.filter((e) => e.context?.trace_id === root.context?.trace_id);
      expect(correlated).toHaveLength(4);
      expect(correlated.find((e) => e.message === "report.build")?.context?.parent_span_id).toBe(root.context?.span_id);
    }
    expect(JSON.stringify(events)).not.toContain("private-");
    expect(JSON.stringify(events)).not.toContain("secret=");
    expect(client.getTraceContext()).toBeUndefined();
  } finally {
    await app.close();
    await client.close();
  }
});
