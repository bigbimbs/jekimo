/**
 * Invitations and password resets without email, password changes, session
 * management, instance user administration, and the audit log route
 * (docs/access-model.md, "Authentication", "Instance roles", "Audit log").
 */

import { beforeEach, describe, expect, it } from "vitest";
import { runAdminCommand } from "../src/admin-command.js";
import { SESSION_COOKIE } from "../src/session.js";
import { fakeHasher, type Harness, harness, PASSWORD, projectWithKey, type SignedIn, signIn } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_PASSWORD = "another-synthetic-passphrase";

let h: Harness;
let admin: SignedIn;

beforeEach(async () => {
  h = await harness({ config: { publicUrl: "https://jekimo.example.test" } });
  admin = await signIn(h, "admin@example.test", "admin");
});

function login(email: string, password: string) {
  return h.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
}

async function invite(email: string, instance_role?: string) {
  return h.app.inject({
    method: "POST",
    url: "/api/v1/invitations",
    headers: admin.headers,
    payload: { email, ...(instance_role && { instance_role }) },
  });
}

describe("invitations", () => {
  it("returns a single-use link once; accepting it creates the user with a password", async () => {
    const res = await invite("new@example.test");
    expect(res.statusCode).toBe(201);
    const { invitation, token, link } = res.json();
    expect(invitation).toMatchObject({
      email: "new@example.test",
      instance_role: "member",
      created_by: admin.userId,
      expires_at: new Date(h.now.value.getTime() + 7 * DAY_MS).toISOString(),
    });
    expect(link).toBe(`https://jekimo.example.test/invite#token=${token}`);
    // Stored and listed without the token.
    expect(JSON.stringify(h.metadata.tokens)).not.toContain(token);
    const list = await h.app.inject({ method: "GET", url: "/api/v1/invitations", headers: admin.headers });
    expect(list.json().invitations).toEqual([invitation]);
    expect(list.body).not.toContain(token);
    expect(JSON.stringify(h.metadata.audit)).not.toContain(token);
    expect(h.metadata.audit.at(-1)).toMatchObject({ action: "user.invited", targetId: invitation.id });

    const weak = await h.app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: { token, password: "short" },
    });
    expect([weak.statusCode, weak.json().error.code]).toEqual([400, "weak_password"]);
    const accepted = await h.app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: { token, password: NEW_PASSWORD },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().user).toMatchObject({
      email: "new@example.test",
      instance_role: "member",
      status: "active",
    });
    expect(accepted.body).not.toContain(NEW_PASSWORD);
    expect(h.metadata.audit.at(-1)).toMatchObject({ action: "user.activated", details: { invited_by: admin.userId } });
    expect((await login("new@example.test", NEW_PASSWORD)).statusCode).toBe(200);

    const reused = await h.app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: { token, password: NEW_PASSWORD },
    });
    expect([reused.statusCode, reused.json().error.code]).toEqual([400, "invalid_token"]);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/invitations", headers: admin.headers })).json()).toEqual({
      invitations: [],
    });
  });

  it("expires after JEKIMO_INVITE_EXPIRY_DAYS", async () => {
    h = await harness({ config: { inviteExpiryDays: 2 } });
    admin = await signIn(h, "admin@example.test", "admin");
    const { token, link, invitation } = (await invite("late@example.test")).json();
    expect(link).toBe(`/invite#token=${token}`);
    expect(invitation.expires_at).toBe(new Date(h.now.value.getTime() + 2 * DAY_MS).toISOString());
    h.now.value = new Date(h.now.value.getTime() + 2 * DAY_MS);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: { token, password: NEW_PASSWORD },
    });
    expect([res.statusCode, res.json().error.code]).toEqual([400, "invalid_token"]);
  });

  it("can be revoked, and a new invitation replaces the pending one", async () => {
    const first = (await invite("twice@example.test")).json();
    const second = (await invite("twice@example.test", "admin")).json();
    const accept = (token: string) =>
      h.app.inject({ method: "POST", url: "/api/v1/invitations/accept", payload: { token, password: NEW_PASSWORD } });
    expect((await accept(first.token)).statusCode).toBe(400);
    const revoke = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/invitations/${second.invitation.id}`,
      headers: admin.headers,
    });
    expect(revoke.statusCode).toBe(204);
    expect((await accept(second.token)).statusCode).toBe(400);
    const again = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/invitations/${second.invitation.id}`,
      headers: admin.headers,
    });
    expect(again.statusCode).toBe(404);
  });

  it("validates input and refuses an email that already has an account", async () => {
    expect((await invite("not-an-email")).statusCode).toBe(400);
    expect((await invite("x@example.test", "owner")).statusCode).toBe(400);
    const taken = await invite("ADMIN@example.test");
    expect([taken.statusCode, taken.json().error.code]).toEqual([409, "email_taken"]);
    for (const token of [undefined, "short", "x".repeat(43).replace(/x$/, "!")]) {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/v1/invitations/accept",
        payload: { token, password: NEW_PASSWORD },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("is for instance admins only", async () => {
    const member = await signIn(h, "member@example.test");
    for (const [method, url] of [
      ["POST", "/api/v1/invitations"],
      ["GET", "/api/v1/invitations"],
      ["GET", "/api/v1/users"],
      ["GET", "/api/v1/audit-log"],
      ["POST", `/api/v1/users/${admin.userId}/password-reset`],
      ["DELETE", `/api/v1/users/${admin.userId}/sessions`],
      ["PATCH", `/api/v1/users/${admin.userId}`],
    ] as const) {
      const res = await h.app.inject({
        method,
        url,
        headers: member.headers,
        ...(method === "POST" || method === "PATCH" ? { payload: { email: "x@example.test", status: "active" } } : {}),
      });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
  });
});

describe("password reset links", () => {
  it("lets an instance admin hand a user a single-use reset link that ends every session", async () => {
    const user = await signIn(h, "user@example.test");
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/users/${user.userId}/password-reset`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(201);
    const { token, link, reset } = res.json();
    expect(link).toBe(`https://jekimo.example.test/reset-password#token=${token}`);
    expect(reset).toMatchObject({ user_id: user.userId });
    expect(JSON.stringify(h.metadata.audit)).not.toContain(token);

    const done = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: { token, password: NEW_PASSWORD },
    });
    expect(done.statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: user.headers })).statusCode).toBe(
      401,
    );
    expect((await login("user@example.test", PASSWORD)).statusCode).toBe(401);
    expect((await login("user@example.test", NEW_PASSWORD)).statusCode).toBe(200);
    const reused = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: { token, password: NEW_PASSWORD },
    });
    expect(reused.statusCode).toBe(400);
  });

  it("answers 404 for an unknown user", async () => {
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
      const res = await h.app.inject({
        method: "POST",
        url: `/api/v1/users/${id}/password-reset`,
        headers: admin.headers,
      });
      expect([res.statusCode, res.json().error.code]).toEqual([404, "user_not_found"]);
    }
  });

  it("prints a reset link from `jekimo admin reset-password <email>`", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = {
      metadata: h.metadata,
      inviteExpiryDays: 7,
      publicUrl: null,
      clock: () => h.now.value,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
    };
    expect(await runAdminCommand(["admin", "reset-password", "ADMIN@example.test"], deps)).toBe(0);
    const line = out.find((l) => l.includes("/reset-password#token="))!;
    const token = line.trim().split("#token=")[1]!;
    expect(h.metadata.audit.at(-1)).toMatchObject({
      action: "user.password_reset_link_created",
      actorUserId: null,
      targetId: admin.userId,
      details: { via: "cli" },
    });
    const done = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: { token, password: NEW_PASSWORD },
    });
    expect(done.statusCode).toBe(200);

    expect(await runAdminCommand(["admin", "reset-password", "nobody@example.test"], deps)).toBe(1);
    expect(await runAdminCommand(["admin"], deps)).toBe(2);
    expect(err.at(-1)).toContain("usage: jekimo admin reset-password <email>");
  });
});

describe("own password and sessions", () => {
  it("changes the password and revokes the user's other sessions", async () => {
    const user = await signIn(h, "user@example.test");
    const second = await login("user@example.test", PASSWORD);
    const secondCookie = `${SESSION_COOKIE}=${second.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;

    const wrong = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: user.headers,
      payload: { current_password: "not-the-password", new_password: NEW_PASSWORD },
    });
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([403, "invalid_credentials"]);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: user.headers,
      payload: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(204);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: user.headers })).statusCode).toBe(
      200,
    );
    expect(
      (await h.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: secondCookie } }))
        .statusCode,
    ).toBe(401);
    expect(h.metadata.users.find((u) => u.id === user.userId)!.passwordHash).toBe(await fakeHasher.hash(NEW_PASSWORD));
    expect(h.metadata.audit.at(-1)).toMatchObject({
      action: "user.password_changed",
      details: { sessions_revoked: 1 },
    });
    expect(JSON.stringify(h.metadata.audit)).not.toContain(NEW_PASSWORD);
  });

  it("lists and revokes the user's own sessions only", async () => {
    const user = await signIn(h, "user@example.test");
    await login("user@example.test", PASSWORD);
    const list = await h.app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: user.headers });
    const sessions = list.json().sessions as { id: string; current: boolean }[];
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    const other = sessions.find((s) => !s.current)!;

    // Another user cannot revoke it.
    const stranger = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${other.id}`,
      headers: admin.headers,
    });
    expect(stranger.statusCode).toBe(404);
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${other.id}`,
      headers: user.headers,
    });
    expect(res.statusCode).toBe(204);
    expect(h.metadata.audit.at(-1)).toMatchObject({ action: "session.revoked", details: { session_id: other.id } });
    const after = await h.app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: user.headers });
    expect(after.json().sessions).toHaveLength(1);
  });

  it("lets an instance admin revoke any user's sessions", async () => {
    const user = await signIn(h, "user@example.test");
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/users/${user.userId}/sessions`,
      headers: admin.headers,
    });
    expect(res.json()).toEqual({ revoked: 1 });
    expect((await h.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: user.headers })).statusCode).toBe(
      401,
    );
  });
});

describe("instance users", () => {
  it("deactivates a user, ending their sessions and sign-in, and reactivates them", async () => {
    const user = await signIn(h, "user@example.test");
    const patch = (status: string) =>
      h.app.inject({
        method: "PATCH",
        url: `/api/v1/users/${user.userId}`,
        headers: admin.headers,
        payload: { status },
      });
    const res = await patch("deactivated");
    expect(res.json().user).toMatchObject({ id: user.userId, status: "deactivated" });
    expect((await h.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: user.headers })).statusCode).toBe(
      401,
    );
    expect((await login("user@example.test", PASSWORD)).statusCode).toBe(401);
    expect((await patch("active")).statusCode).toBe(200);
    expect((await login("user@example.test", PASSWORD)).statusCode).toBe(200);
    expect(h.metadata.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["user.deactivated", "user.reactivated"]),
    );
  });

  it("always keeps one active instance admin", async () => {
    const patch = (payload: Record<string, unknown>) =>
      h.app.inject({ method: "PATCH", url: `/api/v1/users/${admin.userId}`, headers: admin.headers, payload });
    for (const payload of [{ instance_role: "member" }, { status: "deactivated" }]) {
      const res = await patch(payload);
      expect([res.statusCode, res.json().error.code]).toEqual([409, "last_admin"]);
    }
    const other = await signIn(h, "other@example.test");
    const promote = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/users/${other.userId}`,
      headers: admin.headers,
      payload: { instance_role: "admin" },
    });
    expect(promote.json().user.instance_role).toBe("admin");
    expect((await patch({ instance_role: "member" })).statusCode).toBe(200);
    expect(h.metadata.audit.at(-1)).toMatchObject({
      action: "user.role_changed",
      details: { before: "admin", after: "member" },
    });
  });

  it("lists users without password hashes", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/v1/users", headers: admin.headers });
    expect(res.json().users).toEqual([
      expect.objectContaining({ email: "admin@example.test", instance_role: "admin" }),
    ]);
    expect(res.body).not.toContain("fake$");
  });
});

describe("audit log route", () => {
  it("lists entries newest first with paging and filters by actor, action, and time", async () => {
    const owner = await signIn(h, "owner@example.test");
    await projectWithKey(h, owner, "prj_audit");
    h.now.value = new Date(h.now.value.getTime() + 60_000);
    await login("owner@example.test", "wrong-password-123");

    const all = await h.app.inject({ method: "GET", url: "/api/v1/audit-log", headers: admin.headers });
    const entries = all.json().entries as { id: string; action: string }[];
    expect(entries.map((e) => e.action)).toEqual([
      "auth.login_failed",
      "ingestion_key.created",
      "project.created",
      "auth.login",
      "auth.login",
    ]);
    expect(Number(entries[0]!.id)).toBeGreaterThan(Number(entries[1]!.id));

    const page1 = await h.app.inject({ method: "GET", url: "/api/v1/audit-log?limit=2", headers: admin.headers });
    expect(page1.json().entries).toHaveLength(2);
    const page2 = await h.app.inject({
      method: "GET",
      url: `/api/v1/audit-log?limit=2&cursor=${page1.json().next_cursor}`,
      headers: admin.headers,
    });
    expect(page2.json().entries.map((e: { action: string }) => e.action)).toEqual(["project.created", "auth.login"]);
    const page3 = await h.app.inject({
      method: "GET",
      url: `/api/v1/audit-log?limit=2&cursor=${page2.json().next_cursor}`,
      headers: admin.headers,
    });
    expect(page3.json().entries).toHaveLength(1);
    expect(page3.json().next_cursor).toBeUndefined();

    const byActor = await h.app.inject({
      method: "GET",
      url: `/api/v1/audit-log?actor=${owner.userId}&action=project.created`,
      headers: admin.headers,
    });
    expect(byActor.json().entries).toEqual([
      expect.objectContaining({
        action: "project.created",
        actor: { user_id: owner.userId, email: "owner@example.test" },
        target: { type: "project", id: "prj_audit" },
        project_id: "prj_audit",
        via_instance_admin: false,
      }),
    ]);
    const byTime = await h.app.inject({
      method: "GET",
      url: `/api/v1/audit-log?from=${encodeURIComponent(h.now.value.toISOString())}`,
      headers: admin.headers,
    });
    expect(byTime.json().entries.map((e: { action: string }) => e.action)).toEqual(["auth.login_failed"]);

    for (const q of ["?actor=nope", "?action=made.up", "?limit=0", "?limit=501", "?cursor=abc", "?from=yesterday"]) {
      const res = await h.app.inject({ method: "GET", url: `/api/v1/audit-log${q}`, headers: admin.headers });
      expect({ q, status: res.statusCode }).toEqual({ q, status: 400 });
    }
  });

  it("never records passwords, keys, or session tokens, for key creation and sign-in failure", async () => {
    const owner = await signIn(h, "owner@example.test");
    const { projectId } = await projectWithKey(h, owner, "prj_secrets");
    const created = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/keys`,
      headers: owner.headers,
      payload: { name: "ci" },
    });
    const fullKey = created.json().key as string;
    const failed = "a-wrong-password-for-the-audit-test";
    await login("owner@example.test", failed);
    const res = await h.app.inject({ method: "GET", url: "/api/v1/audit-log?limit=500", headers: admin.headers });
    const sessionToken = owner.cookie.split("=")[1]!;
    for (const secret of [fullKey, fullKey.split("_")[2]!, failed, PASSWORD, sessionToken, owner.csrf]) {
      expect(res.body).not.toContain(secret);
      expect(JSON.stringify(h.metadata.audit)).not.toContain(secret);
    }
    const actions = res.json().entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("ingestion_key.created");
    expect(actions).toContain("auth.login_failed");
  });
});
