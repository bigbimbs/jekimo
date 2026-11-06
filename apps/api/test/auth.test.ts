import { describe, expect, it } from "vitest";
import { CSRF_HEADER, SESSION_COOKIE } from "../src/session.js";
import { harness, PASSWORD, SETUP_TOKEN, signIn } from "./helpers.js";

describe("setup", () => {
  it("creates the first instance admin once, with the console token", async () => {
    const h = await harness({ setupToken: SETUP_TOKEN });
    expect((await h.app.inject({ method: "GET", url: "/api/v1/setup" })).json()).toEqual({ setup_required: true });
    const body = { email: "admin@example.test", password: PASSWORD };

    const wrong = await h.app.inject({ method: "POST", url: "/api/v1/setup", payload: { ...body, setup_token: "nope" } });
    expect(wrong.statusCode).toBe(401);
    const weak = await h.app.inject({ method: "POST", url: "/api/v1/setup", payload: { ...body, password: "short", setup_token: SETUP_TOKEN } });
    expect(weak.statusCode).toBe(400);

    const ok = await h.app.inject({ method: "POST", url: "/api/v1/setup", payload: { ...body, setup_token: SETUP_TOKEN } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().user).toMatchObject({ email: "admin@example.test", instance_role: "admin" });
    expect(ok.body).not.toContain(PASSWORD);

    const again = await h.app.inject({ method: "POST", url: "/api/v1/setup", payload: { ...body, setup_token: SETUP_TOKEN } });
    expect(again.statusCode).toBe(410);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/setup" })).json()).toEqual({ setup_required: false });
  });

  it("is closed when no token was issued", async () => {
    const h = await harness({ setupToken: null });
    const res = await h.app.inject({ method: "POST", url: "/api/v1/setup", payload: { setup_token: "", email: "a@example.test", password: PASSWORD } });
    expect(res.statusCode).toBe(410);
  });
});

describe("sessions", () => {
  it("sets an HttpOnly, Secure, SameSite=Lax cookie at path /", async () => {
    const h = await harness();
    h.metadata.addUser("user@example.test", `fake$${PASSWORD}`, "member");
    const res = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "USER@example.test", password: PASSWORD } });
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
    const wrong = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "user@example.test", password: "wrong-password-123" } });
    const unknown = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "nobody@example.test", password: "wrong-password-123" } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("locks the account after 10 failures in 15 minutes, answering like a wrong password", async () => {
    const h = await harness();
    h.metadata.addUser("user@example.test", `fake$${PASSWORD}`, "member");
    for (let i = 0; i < 10; i++) {
      await h.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "user@example.test", password: "wrong-password-123" } });
    }
    const locked = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "user@example.test", password: PASSWORD } });
    expect(locked.statusCode).toBe(401);
    expect(locked.json().error.code).toBe("invalid_credentials");
    expect(h.metadata.audit.some((a) => a.action === "auth.login_locked")).toBe(true);
    h.now.value = new Date(h.now.value.getTime() + 16 * 60 * 1000);
    const later = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "user@example.test", password: PASSWORD } });
    expect(later.statusCode).toBe(200);
  });

  it("requires the CSRF header for state changes and revokes on logout", async () => {
    const h = await harness();
    const user = await signIn(h, "user@example.test");
    const noCsrf = await h.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: user.cookie } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe("csrf_failed");
    const session = await h.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: user.cookie } });
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
