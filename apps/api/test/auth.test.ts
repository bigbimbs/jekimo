import type { IngestJob } from "@jekimo/storage-postgres";
import { MemoryEventStore, MemoryMetadataRepository, MemoryQueue } from "@jekimo/storage-postgres/memory";
import { describe, expect, it } from "vitest";
import { buildApp, loggerOptions } from "../src/app.js";
import { CSRF_HEADER, SESSION_COOKIE } from "../src/constants/index.js";
import { fakeHasher, harness, ingestEvent, PASSWORD, SETUP_TOKEN, signIn } from "./helpers.js";

describe("setup", () => {
  it("creates the first instance admin, project, and key once, with the console token", async () => {
    const h = await harness({ setupToken: SETUP_TOKEN });
    expect((await h.app.inject({ method: "GET", url: "/api/v1/setup" })).json()).toEqual({ setup_required: true });
    const body = { email: "admin@example.test", password: PASSWORD, project_name: "Billing API" };

    const wrong = await h.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { ...body, setup_token: "nope" },
    });
    expect(wrong.statusCode).toBe(401);
    const weak = await h.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { ...body, password: "short", setup_token: SETUP_TOKEN },
    });
    expect(weak.statusCode).toBe(400);
    const noProject = await h.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { ...body, project_name: " ", setup_token: SETUP_TOKEN },
    });
    expect(noProject.statusCode).toBe(400);
    expect(await h.metadata.countUsers()).toBe(0);

    const ok = await h.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { ...body, setup_token: SETUP_TOKEN },
    });
    expect(ok.statusCode).toBe(201);
    const created = ok.json();
    expect(created.user).toMatchObject({ email: "admin@example.test", instance_role: "admin" });
    expect(created.project).toMatchObject({ name: "Billing API", retention_days: 30 });
    expect(created.project.id).toMatch(/^prj_[a-z0-9]{16}$/);
    expect(created.ingestion_key.key).toMatch(/^jk_[0-9A-Z]{12}_[a-z0-9]{32}$/);
    expect(created.ingestion_key.key).toContain(created.ingestion_key.key_id);
    expect(ok.body).not.toContain(PASSWORD);
    expect(ok.body).not.toContain(SETUP_TOKEN);

    // The key works for ingest, scoped to the new project.
    const ingest = await h.app.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { authorization: `Bearer ${created.ingestion_key.key}`, "content-type": "application/json" },
      payload: { events: [ingestEvent()] },
    });
    expect(ingest.statusCode).toBe(202);

    // Afterwards every setup route is gone, with or without the token.
    const again = await h.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { ...body, setup_token: SETUP_TOKEN },
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: { code: "not_found", message: "not found" } });
    expect((await h.app.inject({ method: "GET", url: "/api/v1/setup" })).statusCode).toBe(404);
    expect(await h.metadata.countUsers()).toBe(1);
  });

  it("is not found when no token was issued", async () => {
    const h = await harness({ setupToken: null });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_token: "", email: "a@example.test", password: PASSWORD, project_name: "P" },
    });
    expect(res.statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/setup" })).statusCode).toBe(404);
  });

  it("closes when a user already exists, even with a token", async () => {
    const h = await harness({ setupToken: SETUP_TOKEN });
    h.metadata.addUser("other@example.test", `fake$${PASSWORD}`, "admin");
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_token: SETUP_TOKEN, email: "a@example.test", password: PASSWORD, project_name: "P" },
    });
    expect(res.statusCode).toBe(404);
    expect(await h.metadata.countUsers()).toBe(1);
  });

  it("never logs the password, setup token, or ingestion key", async () => {
    const lines: string[] = [];
    const app = await buildApp({
      metadata: new MemoryMetadataRepository(),
      events: new MemoryEventStore(),
      queue: new MemoryQueue<IngestJob>(),
      hasher: fakeHasher,
      setupToken: SETUP_TOKEN,
      logger: { ...(loggerOptions("trace") as object), stream: { write: (line: string) => lines.push(line) } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_token: SETUP_TOKEN, email: "admin@example.test", password: PASSWORD, project_name: "P" },
    });
    expect(res.statusCode).toBe(201);
    const { key, key_id } = res.json().ingestion_key as { key: string; key_id: string };
    const log = lines.join("");
    expect(log).toContain(key_id);
    expect(log).not.toContain(key);
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toContain(SETUP_TOKEN);
  });
});

describe("sessions", () => {
  it("sets an HttpOnly, Secure, SameSite=Lax cookie at path /", async () => {
    const h = await harness();
    h.metadata.addUser("user@example.test", `fake$${PASSWORD}`, "member");
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "USER@example.test", password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const header = String(res.headers["set-cookie"]);
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(h.metadata.audit.map((a) => a.action)).toContain("auth.login");
  });

  it("answers a wrong password and an unknown email the same way", async () => {
    const h = await harness();
    h.metadata.addUser("user@example.test", `fake$${PASSWORD}`, "member");
    const wrong = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.test", password: "wrong-password-123" },
    });
    const unknown = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.test", password: "wrong-password-123" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("locks the account after 10 failures in 15 minutes, answering like a wrong password", async () => {
    const h = await harness();
    h.metadata.addUser("user@example.test", `fake$${PASSWORD}`, "member");
    for (let i = 0; i < 10; i++) {
      await h.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "user@example.test", password: "wrong-password-123" },
      });
    }
    const locked = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.test", password: PASSWORD },
    });
    expect(locked.statusCode).toBe(401);
    expect(locked.json().error.code).toBe("invalid_credentials");
    expect(h.metadata.audit.some((a) => a.action === "auth.login_locked")).toBe(true);
    h.now.value = new Date(h.now.value.getTime() + 16 * 60 * 1000);
    const later = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.test", password: PASSWORD },
    });
    expect(later.statusCode).toBe(200);
  });

  it("requires the CSRF header for state changes and revokes on logout", async () => {
    const h = await harness();
    const user = await signIn(h, "user@example.test");
    const noCsrf = await h.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: user.cookie } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe("csrf_failed");
    const session = await h.app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: user.cookie },
    });
    expect(session.json().csrf_token).toBe(user.csrf);

    const out = await h.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: user.headers });
    expect(out.statusCode).toBe(204);
    const after = await h.app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie: user.cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("expires idle sessions", async () => {
    const h = await harness({ config: { sessionIdleDays: 14 } });
    const user = await signIn(h, "user@example.test");
    h.now.value = new Date(h.now.value.getTime() + 15 * 24 * 60 * 60 * 1000);
    const res = await h.app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie: user.cookie } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects bodies that are not JSON without echoing them", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: '{"email":"a@example.test","password":"synthetic-secret-value"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_json");
    expect(res.body).not.toContain("synthetic-secret-value");
  });

  it("sends the CSRF header name the dashboard expects", () => {
    expect(CSRF_HEADER).toBe("x-jekimo-csrf-token");
  });
});
