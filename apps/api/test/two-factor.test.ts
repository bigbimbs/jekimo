import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdminCommand } from "../src/admin-command.js";
import { buildApp } from "../src/app.js";
import { totpAt } from "../src/two-factor.js";
import { fakeHasher, type Harness, harness, PASSWORD, type SignedIn, signIn } from "./helpers.js";

const KEY = Buffer.alloc(32, 9).toString("base64");
let h: Harness;
let admin: SignedIn;
const code = (secret: string) => totpAt(secret, Math.floor(h.now.value.getTime() / 30_000));
const advance = () => {
  h.now.value = new Date(h.now.value.getTime() + 30_000);
};
const post = (path: string, payload: Record<string, unknown>, user = admin) =>
  h.app.inject({ method: "POST", url: `/api/v1/auth/two-factor/${path}`, headers: user.headers, payload });
const login = (otp?: string, password = PASSWORD, email = "admin@example.test") =>
  h.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password, ...(otp && { code: otp }) } });
async function enroll(user = admin) {
  const start = await post("setup", { password: PASSWORD }, user);
  expect(start.statusCode, start.body).toBe(200);
  expect(start.headers["cache-control"]).toBe("no-store");
  const secret = start.json().secret as string;
  const enabled = await post("enable", { code: code(secret) }, user);
  expect(enabled.statusCode, enabled.body).toBe(200);
  return { secret, codes: enabled.json().recovery_codes as string[] };
}
async function policy(required: boolean, secret: string, user = admin) {
  advance();
  return h.app.inject({
    method: "PUT",
    url: "/api/v1/admin/security",
    headers: user.headers,
    payload: { required, password: PASSWORD, code: code(secret) },
  });
}

beforeEach(async () => {
  h = await harness({ config: { mfaEncryptionKey: KEY } });
  admin = await signIn(h, "admin@example.test", "admin");
});
afterEach(async () => {
  await h.app.close();
});

describe("two-factor authentication", () => {
  it("allows optional enrollment, encrypts the secret, hashes recovery codes, and never reveals them in status or audit", async () => {
    const { secret, codes } = await enroll();
    expect(codes).toHaveLength(8);
    const stored = JSON.stringify(await h.metadata.getTwoFactor(admin.userId));
    expect(stored).not.toContain(secret);
    for (const c of codes) expect(stored).not.toContain(c);
    const status = await h.app.inject({ method: "GET", url: "/api/v1/auth/two-factor", headers: admin.headers });
    expect(status.json()).toEqual({ enabled: true, required: false, configured: true, recovery_codes_remaining: 8 });
    expect(JSON.stringify(h.metadata.audit)).not.toContain(secret);
    for (const c of codes) expect(JSON.stringify(h.metadata.audit)).not.toContain(c);
  });

  it("requires the second factor before issuing a login session and rejects replays", async () => {
    const { secret } = await enroll();
    const missing = await login();
    expect(missing.json().error.code).toBe("two_factor_required");
    expect(missing.cookies).toHaveLength(0);
    expect((await login(code(secret))).json().error.code).toBe("invalid_two_factor_code");
    advance();
    const valid = await login(code(secret));
    expect(valid.statusCode).toBe(200);
    expect(valid.cookies).toHaveLength(1);
    const replay = await login(code(secret));
    expect(replay.json().error.code).toBe("invalid_two_factor_code");
    expect(replay.cookies).toHaveLength(0);
  });

  it("revokes other sessions at enrollment and rejects an old factor version", async () => {
    const second = await login();
    const cookie = `jekimo_session=${second.cookies[0]?.value}`;
    await enroll();
    expect((await h.app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie } })).statusCode).toBe(401);
    const current = h.metadata.sessions.find((s) => s.userId === admin.userId && s.revokedAt === null)!;
    current.twoFactorVersion = "00000000-0000-0000-0000-000000000000";
    expect((await h.app.inject({ method: "GET", url: "/api/v1/projects", headers: admin.headers })).statusCode).toBe(
      401,
    );
  });

  it("permits each recovery code once, including simultaneous attempts", async () => {
    const { codes } = await enroll();
    const attempts = await Promise.all([login(codes[0]), login(codes[0])]);
    expect(attempts.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect((await h.metadata.getTwoFactor(admin.userId)).recoveryHashes).toHaveLength(7);
    expect(h.metadata.audit.some((e) => e.action === "auth.recovery_code_used")).toBe(true);
  });

  it("locks incorrect code attempts persistently for 15 minutes", async () => {
    const { secret } = await enroll();
    for (let i = 0; i < 10; i++) expect((await login("wrong-code")).statusCode).toBe(400);
    advance();
    expect((await login(code(secret))).statusCode).toBe(429);
    h.now.value = new Date(h.now.value.getTime() + 15 * 60_000);
    expect((await login(code(secret))).statusCode).toBe(200);
  });

  it("expires pending setup and keeps protection off until a valid code is supplied", async () => {
    const start = await post("setup", { password: PASSWORD });
    h.now.value = new Date(h.now.value.getTime() + 10 * 60_000);
    const expired = await post("enable", { code: code(start.json().secret) });
    expect(expired.json().error.code).toBe("two_factor_setup_expired");
    expect((await h.metadata.getTwoFactor(admin.userId)).secret).toBeNull();
  });

  it("enforces the policy on old sessions and password-only logins, allowing enrollment and logout only", async () => {
    const member = await signIn(h, "member@example.test");
    const { secret } = await enroll();
    expect((await policy(true, secret)).statusCode).toBe(200);
    for (const url of ["/api/v1/projects", "/api/v1/auth/sessions", "/api/v1/users"]) {
      const denied = await h.app.inject({ method: "GET", url, headers: member.headers });
      expect(denied.json().error.code).toBe("two_factor_enrollment_required");
    }
    const passwordOnly = await login(undefined, PASSWORD, "member@example.test");
    expect(passwordOnly.json().two_factor).toMatchObject({ required: true, enabled: false });
    const session = await h.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: member.headers });
    expect(session.json().two_factor).toEqual({ required: true, enabled: false });
    const memberFactor = await enroll(member);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/projects", headers: member.headers })).statusCode).toBe(
      200,
    );
    advance();
    const disable = await post("disable", { password: PASSWORD, code: code(memberFactor.secret) }, member);
    expect(disable.json().error.code).toBe("two_factor_required_by_admin");
    expect((await policy(false, secret)).statusCode).toBe(200);
    expect((await h.metadata.getTwoFactor(member.userId)).secret).not.toBeNull();
  });

  it("requires enrolled admin authority and reauthentication to change the instance policy", async () => {
    const unenrolled = await h.app.inject({
      method: "PUT",
      url: "/api/v1/admin/security",
      headers: admin.headers,
      payload: { required: true, password: PASSWORD, code: "123456" },
    });
    expect(unenrolled.statusCode).not.toBe(200);
    const member = await signIn(h, "member@example.test");
    const memberFactor = await enroll(member);
    expect((await policy(true, memberFactor.secret, member)).statusCode).toBe(403);
    expect(await h.metadata.isTwoFactorRequired()).toBe(false);
    const { secret } = await enroll();
    advance();
    const wrongPassword = await h.app.inject({
      method: "PUT",
      url: "/api/v1/admin/security",
      headers: admin.headers,
      payload: { required: true, password: "wrong", code: code(secret) },
    });
    expect(wrongPassword.statusCode).toBe(403);
    expect(await h.metadata.isTwoFactorRequired()).toBe(false);
  });

  it("replaces recovery codes only after reauthentication and allows opt-out while optional", async () => {
    const { secret, codes } = await enroll();
    advance();
    const regenerated = await post("recovery-codes", { password: PASSWORD, code: code(secret) });
    expect(regenerated.json().recovery_codes).toHaveLength(8);
    expect((await login(codes[0])).statusCode).toBe(400);
    const disabled = await post("disable", { password: PASSWORD, code: regenerated.json().recovery_codes[0] });
    expect(disabled.statusCode).toBe(204);
    expect((await login()).statusCode).toBe(200);
  });

  it("never bypasses 2FA on password reset; the explicit operator reset revokes every session", async () => {
    const { secret } = await enroll();
    expect((await policy(true, secret)).statusCode).toBe(200);
    const reset = await h.app.inject({
      method: "POST",
      url: `/api/v1/users/${admin.userId}/password-reset`,
      headers: admin.headers,
      payload: {},
    });
    const changed = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: { token: reset.json().token, password: "new-synthetic-password" },
    });
    expect(changed.statusCode).toBe(200);
    expect((await login(undefined, "new-synthetic-password")).json().error.code).toBe("two_factor_required");
    const output: string[] = [];
    expect(
      await runAdminCommand(["admin", "reset-two-factor", "admin@example.test"], {
        metadata: h.metadata,
        clock: () => h.now.value,
        inviteExpiryDays: 7,
        publicUrl: null,
        out: (s) => output.push(s),
        err: (s) => output.push(s),
      }),
    ).toBe(0);
    expect((await h.metadata.getTwoFactor(admin.userId)).secret).toBeNull();
    expect(h.metadata.sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect(await h.metadata.isTwoFactorRequired()).toBe(true);
    expect((await login(undefined, "new-synthetic-password")).json().two_factor).toMatchObject({
      required: true,
      enabled: false,
    });
    expect(output.join("")).not.toContain(secret);
  });

  it("exposes the audit action catalogue only to instance admins", async () => {
    const member = await signIn(h, "member@example.test");
    const forbidden = await h.app.inject({ method: "GET", url: "/api/v1/audit-log/actions", headers: member.headers });
    expect(forbidden.statusCode).toBe(403);
    const allowed = await h.app.inject({ method: "GET", url: "/api/v1/audit-log/actions", headers: admin.headers });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().actions).toContain("auth.two_factor_enabled");
    expect(allowed.json().actions).toContain("auth.recovery_code_used");
  });

  it("requires CSRF and rejects ingestion credentials on every 2FA endpoint", async () => {
    const denied = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/two-factor/setup",
      headers: { cookie: admin.cookie },
      payload: { password: PASSWORD },
    });
    expect(denied.json().error.code).toBe("csrf_failed");
    for (const url of ["/api/v1/auth/two-factor", "/api/v1/admin/security"])
      expect(
        (
          await h.app.inject({
            method: "GET",
            url,
            headers: { ...admin.headers, authorization: "Bearer synthetic-ingestion-key" },
          })
        ).statusCode,
      ).toBe(401);
  });

  it("fails closed if an enrolled user reaches a server without the encryption key", async () => {
    await enroll();
    const third = await buildApp({
      metadata: h.metadata,
      events: h.events,
      queue: h.queue,
      clock: () => h.now.value,
      hasher: fakeHasher,
    });
    const missingKey = await third.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.test", password: PASSWORD, code: "123456" },
    });
    expect(missingKey.statusCode).toBe(503);
    expect(missingKey.cookies).toHaveLength(0);
    await third.close();
  });
});
