import { randomUUID } from "node:crypto";
import type { CronRepository } from "@jekimo/storage-postgres";
import { MemoryEventStore, MemoryMetadataRepository, MemoryQueue } from "@jekimo/storage-postgres/memory";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { generateIngestionKey } from "../src/keys.js";
import { fakeHasher, PASSWORD } from "./helpers.js";

describe("cron API", () => {
  let app: FastifyInstance;
  let repo: CronRepository;
  let admin: Record<string, string>;
  let member: Record<string, string>;
  let key: string;
  const monitor = randomUUID();
  const input = {
    name: "Backup",
    expression: "0 2 * * *",
    timezone: "UTC",
    graceSeconds: 60,
    maxRuntimeSeconds: 300,
    failureThreshold: 1,
    recoveryThreshold: 1,
    channelId: null,
  };
  beforeEach(async () => {
    const meta = new MemoryMetadataRepository();
    const owner = meta.addUser("admin@example.test", await fakeHasher.hash(PASSWORD), "admin");
    meta.addUser("member@example.test", await fakeHasher.hash(PASSWORD), "member");
    const actor = { userId: owner.id, instanceRole: "admin" as const };
    await meta.createProject(actor, { id: "one", name: "One", retentionDays: 30 });
    const access = (await meta.resolveProjectAccess(actor, "one"))!;
    const k = generateIngestionKey();
    key = k.key;
    await meta.createIngestionKey(access, { keyId: k.keyId, keyHash: k.keyHash, name: "Cron" });
    repo = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({
        ...input,
        id: monitor,
        enabled: true,
        health: "pending",
        nextExpectedAt: new Date(),
        lastSuccessAt: null,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        incidentOpen: false,
      })),
      setEnabled: vi.fn(async () => true),
      runs: vi.fn(async () => []),
      checkIn: vi.fn(async () => ({
        id: randomUUID(),
        status: "started",
        startedAt: new Date(),
        finishedAt: null,
        expectedAt: null,
        deadlineAt: new Date(),
      })),
    } as unknown as CronRepository;
    app = await buildApp({
      metadata: meta,
      events: new MemoryEventStore(),
      queue: new MemoryQueue(),
      hasher: fakeHasher,
      cron: repo,
    });
    async function login(email: string) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: PASSWORD },
      });
      return {
        cookie: `jekimo_session=${res.cookies[0]?.value}`,
        "x-jekimo-csrf-token": res.json().csrf_token as string,
      };
    }
    admin = await login("admin@example.test");
    member = await login("member@example.test");
  });
  afterEach(async () => {
    await app.close();
  });
  it("guards management and validates schedules", async () => {
    expect((await app.inject({ url: "/api/v1/projects/one/cron-monitors", headers: member })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/projects/one/cron-monitors",
          headers: { cookie: admin.cookie! },
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/projects/one/cron-monitors",
          headers: admin,
          payload: { ...input, expression: "* * * * * *" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/projects/one/cron-monitors", headers: admin, payload: input }))
        .statusCode,
    ).toBe(201);
  });
  it("derives project identity from the ingestion key and rejects project overrides", async () => {
    const runId = randomUUID();
    const url = `/api/v1/cron/${monitor}/check-ins`;
    const payload = { run_id: runId, status: "started" };
    expect((await app.inject({ method: "POST", url, headers: admin, payload })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url, headers: { authorization: "Bearer invalid" }, payload })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${key}` },
          payload: { ...payload, project_id: "two" },
        })
      ).statusCode,
    ).toBe(400);
    const res = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key}` }, payload });
    expect(res.statusCode, res.body).toBe(200);
    expect(repo.checkIn).toHaveBeenCalledWith("one", monitor, { runId, status: "started" }, expect.any(Date));
  });
  it("maps paused, unknown, conflicting and throttled check-ins to clear errors", async () => {
    for (const [result, status] of [
      ["disabled", 409],
      ["not_found", 404],
      ["conflict", 409],
      ["rate_limited", 429],
    ] as const) {
      vi.mocked(repo.checkIn).mockResolvedValueOnce(result);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/cron/${monitor}/check-ins`,
        headers: { authorization: `Bearer ${key}` },
        payload: { run_id: randomUUID(), status: "ok" },
      });
      expect(res.statusCode).toBe(status);
    }
  });
});
