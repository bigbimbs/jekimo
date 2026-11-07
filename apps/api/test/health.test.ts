import type { IngestJob } from "@jekimo/storage-postgres";
import { MemoryEventStore, MemoryMetadataRepository, MemoryQueue } from "@jekimo/storage-postgres/memory";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

async function app(readiness: Record<string, () => Promise<unknown>>) {
  return buildApp({
    metadata: new MemoryMetadataRepository(),
    events: new MemoryEventStore(),
    queue: new MemoryQueue<IngestJob>(),
    readiness,
  });
}

const down = () =>
  Promise.reject(Object.assign(new Error("connect ECONNREFUSED db.internal:5432"), { code: "ECONNREFUSED" }));

describe("health checks", () => {
  it("reports liveness without touching dependencies", async () => {
    let calls = 0;
    const a = await app({ database: async () => calls++ });
    const res = await a.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["x-jekimo-request-id"]).toBeTruthy();
    expect(calls).toBe(0);
  });

  it("is ready when the database and queue answer", async () => {
    const a = await app({ database: async () => 1, queue: async () => 1 });
    const res = await a.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { database: "ok", queue: "ok" } });
  });

  it("answers 503 with an error body naming what is unreachable", async () => {
    const a = await app({ database: async () => 1, queue: down });
    const res = await a.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "unavailable",
      checks: { database: "ok", queue: "unavailable" },
      error: { code: "not_ready", message: "not reachable: queue" },
    });
    expect(res.body).not.toContain("db.internal");
    // Liveness is unaffected.
    expect((await a.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("times out a check that hangs", async () => {
    const a = await app({ database: () => new Promise(() => {}) });
    const res = await a.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ database: "unavailable" });
  }, 5000);
});
