import type { NotificationRepository } from "@jekimo/storage-postgres";
import { openNotification } from "@jekimo/storage-postgres";
import { MemoryEventStore, MemoryMetadataRepository, MemoryQueue } from "@jekimo/storage-postgres/memory";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { fakeHasher, PASSWORD } from "./helpers.js";

const KEY = "a".repeat(64);
describe("notification API", () => {
  let app: FastifyInstance;
  let meta: MemoryMetadataRepository;
  let repo: NotificationRepository;
  let admin: Record<string, string>;
  let member: Record<string, string>;
  let smtp: string | null;
  async function login(email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    return {
      cookie: `jekimo_session=${res.cookies[0]?.value}`,
      "x-jekimo-csrf-token": res.json().csrf_token as string,
    };
  }
  beforeEach(async () => {
    smtp = null;
    meta = new MemoryMetadataRepository();
    const owner = meta.addUser("admin@example.test", await fakeHasher.hash(PASSWORD), "admin");
    meta.addUser("member@example.test", await fakeHasher.hash(PASSWORD), "member");
    await meta.createProject(
      { userId: owner.id, instanceRole: "admin" },
      { id: "project", name: "Project", retentionDays: 30 },
    );
    repo = {
      getSmtp: vi.fn(async () => smtp),
      saveSmtp: vi.fn(async (_actor, value) => {
        smtp = value;
      }),
      listChannels: vi.fn(async () => []),
      saveChannel: vi.fn(),
      listRules: vi.fn(async () => []),
      saveRule: vi.fn(async () => true),
      listDeliveries: vi.fn(async () => []),
      enqueueEmail: vi.fn(async () => true),
    } as unknown as NotificationRepository;
    app = await buildApp({
      metadata: meta,
      events: new MemoryEventStore(),
      queue: new MemoryQueue(),
      hasher: fakeHasher,
      notifications: { repository: repo, encryptionKey: KEY },
    });
    admin = await login("admin@example.test");
    member = await login("member@example.test");
  });
  afterEach(async () => {
    await app.close();
  });
  it("requires admin for SMTP, project permission for connections, and CSRF on writes", async () => {
    expect((await app.inject({ url: "/api/v1/admin/email", headers: member })).statusCode).toBe(403);
    expect(
      (await app.inject({ url: "/api/v1/projects/project/notification-channels", headers: member })).statusCode,
    ).toBe(404);
    expect((await app.inject({ url: "/api/v1/admin/email" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "PUT", url: "/api/v1/admin/email", headers: { cookie: admin.cookie! }, payload: {} }))
        .statusCode,
    ).toBe(403);
    expect(repo.listChannels).not.toHaveBeenCalled();
  });
  it("encrypts SMTP credentials and never returns them, including when retaining the password", async () => {
    const payload = {
      host: "smtp.example.test",
      port: 587,
      security: "starttls",
      username: "user",
      password: "synthetic-secret",
      from: "alerts@example.test",
      fromName: "Jekimo",
      enabled: true,
    };
    const saved = await app.inject({ method: "PUT", url: "/api/v1/admin/email", headers: admin, payload });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain("synthetic-secret");
    expect(saved.headers["cache-control"]).toBe("no-store");
    expect(smtp).not.toContain("synthetic-secret");
    expect(openNotification(smtp!, KEY, "smtp")).toMatchObject({ password: "synthetic-secret" });
    const { password: _, ...update } = payload;
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/email",
      headers: admin,
      payload: { ...update, fromName: "Changed" },
    });
    expect(openNotification(smtp!, KEY, "smtp")).toMatchObject({ password: "synthetic-secret", fromName: "Changed" });
    const test = await app.inject({
      method: "POST",
      url: "/api/v1/admin/email/test",
      headers: admin,
      payload: { recipient: "tester@example.test" },
    });
    expect(test.statusCode).toBe(202);
  });
  it("validates destinations and returns only public channel fields", async () => {
    const base = {
      name: "Ops",
      kind: "webhook",
      destination: "http://example.test/hook",
      signingSecret: "s".repeat(32),
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/projects/project/notification-channels",
          headers: admin,
          payload: base,
        })
      ).statusCode,
    ).toBe(400);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/notification-channels",
      headers: admin,
      payload: { ...base, destination: "https://example.test/secret" },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body).not.toContain("secret");
    const [access, channel, encrypted] = vi.mocked(repo.saveChannel).mock.calls[0]!;
    expect(access.projectId).toBe("project");
    expect(openNotification(encrypted, KEY, channel.id)).toEqual({
      destination: "https://example.test/secret",
      signingSecret: "s".repeat(32),
    });
  });
  it("rejects malformed rule ids and unsafe email inputs before storage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/alert-rules",
      headers: admin,
      payload: { name: "Errors", channelId: "bad", trigger: "new_issue", cooldownMinutes: 15, enabled: true },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.saveRule).not.toHaveBeenCalled();
    const mail = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project/notification-channels",
      headers: admin,
      payload: { name: "Mail", kind: "email", destination: "victim@example.test\r\nBcc: other@example.test" },
    });
    expect(mail.statusCode).toBe(400);
  });
  it("validates and saves slow-query rules with permission and CSRF checks", async () => {
    const channelId = "00000000-0000-4000-8000-000000000001";
    const payload = {
      name: "Slow invoices",
      channelId,
      trigger: "slow_query",
      thresholdMs: 500,
      environment: "production",
      queryName: "invoices.list",
      cooldownMinutes: 15,
      enabled: true,
    };
    const url = "/api/v1/projects/project/alert-rules";
    expect((await app.inject({ method: "POST", url, headers: member, payload })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url, headers: { cookie: admin.cookie! }, payload })).statusCode).toBe(
      403,
    );
    for (const thresholdMs of [undefined, 0, -1, 500.5, 604800001, "500", null])
      expect(
        (await app.inject({ method: "POST", url, headers: admin, payload: { ...payload, thresholdMs } })).statusCode,
      ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url, headers: admin, payload: { ...payload, queryName: "x".repeat(129) } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url, headers: admin, payload: { ...payload, trigger: "new_issue" } }))
        .statusCode,
    ).toBe(400);
    expect(repo.saveRule).not.toHaveBeenCalled();
    const result = await app.inject({ method: "POST", url, headers: admin, payload });
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json().rule).toMatchObject(payload);
    expect(result.headers["cache-control"]).toBe("no-store");
    const saved = vi.mocked(repo.saveRule).mock.calls[0]!;
    expect(saved[0].projectId).toBe("project");
    expect(saved[1]).toMatchObject(payload);
    const updated = await app.inject({
      method: "PUT",
      url: `${url}/${saved[1].id}`,
      headers: admin,
      payload: { ...payload, thresholdMs: 750 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().rule.thresholdMs).toBe(750);
  });
});
