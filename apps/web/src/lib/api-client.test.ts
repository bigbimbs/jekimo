import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./api-client";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SESSION = {
  user: { id: "u1", email: "a@example.test", instance_role: "member", created_at: "2026-11-01T00:00:00Z" },
  csrf_token: "csrf-1",
};

function setup(responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const r of responses) fetch.mockResolvedValueOnce(r);
  const onUnauthorized = vi.fn();
  const api = createApiClient({ fetch, onUnauthorized });
  const call = (i: number) => {
    const [url, init] = fetch.mock.calls[i] ?? [];
    return { url, init, headers: (init?.headers ?? {}) as Record<string, string> };
  };
  return { api, fetch, onUnauthorized, call };
}

describe("createApiClient", () => {
  it("sends the session's CSRF token on state changes only", async () => {
    const { api, call } = setup([
      json(200, SESSION),
      json(200, { projects: [] }),
      json(200, { issue: { id: "i1", status: "resolved" } }),
    ]);
    await api.getSession();
    await api.listProjects();
    await api.changeIssueStatus("prj_a", "i1", "resolve");

    expect(call(1).headers["x-jekimo-csrf-token"]).toBeUndefined();
    expect(call(2).init?.method).toBe("POST");
    expect(call(2).url).toBe("/api/v1/projects/prj_a/issues/i1/resolve");
    expect(call(2).headers["x-jekimo-csrf-token"]).toBe("csrf-1");
    expect(call(2).init?.credentials).toBe("same-origin");
  });

  it("never sends an Authorization header", async () => {
    const { api, call } = setup([json(200, SESSION), json(201, { key_id: "K1", key: "jk_K1_secret", name: "" })]);
    await api.login("a@example.test", "password-123456");
    await api.createKey("prj_a", "ci");
    for (const i of [0, 1]) expect(Object.keys(call(i).headers)).not.toContain("authorization");
  });

  it("reports an expired session and forgets the CSRF token", async () => {
    const { api, onUnauthorized, call } = setup([
      json(200, SESSION),
      json(401, { error: { code: "unauthorized", message: "session expired" } }),
      new Response(null, { status: 204 }),
    ]);
    await api.getSession();
    await expect(api.listProjects()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledOnce();

    await api.logout().catch(() => undefined);
    expect(call(2).headers["x-jekimo-csrf-token"]).toBeUndefined();
  });

  it("treats a 401 from sign-in as an answer, not an expired session", async () => {
    const { api, onUnauthorized } = setup([json(401, { error: { code: "invalid_credentials", message: "no" } })]);
    await expect(api.login("a@example.test", "wrong")).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("turns error bodies and network failures into ApiError codes", async () => {
    const { api, fetch } = setup([json(409, { error: { code: "key_not_active", message: "not active" } })]);
    const err = await api.rotateKey("prj_a", "K1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "key_not_active", message: "not active" });

    fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(api.listProjects()).rejects.toMatchObject({ status: 0, code: "network" });

    fetch.mockResolvedValueOnce(new Response("<html>", { status: 502 }));
    await expect(api.listProjects()).rejects.toMatchObject({ status: 502, code: "internal" });
  });

  it("escapes ids in paths and sends issue filters as query parameters", async () => {
    const { api, call } = setup([json(200, { issues: [] })]);
    await api.listIssues("prj/../x", { limit: 50, status: "unresolved", severity: "error", cursor: "c 1" });
    expect(call(0).url).toBe(
      "/api/v1/projects/prj%2F..%2Fx/issues?limit=50&status=unresolved&severity=error&cursor=c+1",
    );
  });

  it("keeps a 2FA login challenge out of the expired-session flow and sends the next code", async () => {
    const { api, onUnauthorized, call } = setup([
      json(401, { error: { code: "two_factor_required", message: "code required" } }),
      json(200, SESSION),
    ]);
    await expect(api.login("a@example.test", "synthetic-password")).rejects.toMatchObject({
      code: "two_factor_required",
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
    await api.login("a@example.test", "synthetic-password", "123456");
    expect(JSON.parse(String(call(1).init?.body))).toEqual({
      email: "a@example.test",
      password: "synthetic-password",
      code: "123456",
    });
  });

  it("routes newly enforced sessions to enrollment when project access is rejected", async () => {
    const onEnrollmentRequired = vi.fn();
    const api = createApiClient({
      onEnrollmentRequired,
      fetch: vi
        .fn()
        .mockResolvedValue(json(403, { error: { code: "two_factor_enrollment_required", message: "enroll" } })),
    });
    await expect(api.listProjects()).rejects.toMatchObject({ code: "two_factor_enrollment_required" });
    expect(onEnrollmentRequired).toHaveBeenCalledOnce();
  });

  it("treats a closed setup as not required", async () => {
    const { api } = setup([json(404, { error: { code: "not_found", message: "not found" } })]);
    await expect(api.setupRequired()).resolves.toBe(false);
  });

  it("scopes member changes, encodes ids, sends CSRF, and handles a 204 removal", async () => {
    const member = { user_id: "u/1", email: "member@example.test", role: "viewer" };
    const { api, call } = setup([
      json(200, SESSION),
      json(201, { member }),
      json(200, { member: { ...member, role: "member" } }),
      new Response(null, { status: 204 }),
    ]);
    await api.getSession();
    await expect(api.addMember("prj/a", member.email, "viewer")).resolves.toEqual(member);
    await expect(api.changeMemberRole("prj/a", "u/1", "member")).resolves.toMatchObject({ role: "member" });
    await expect(api.removeMember("prj/a", "u/1")).resolves.toBeUndefined();
    expect(call(1).url).toBe("/api/v1/projects/prj%2Fa/members");
    expect(call(1).init?.method).toBe("POST");
    expect(JSON.parse(String(call(1).init?.body))).toEqual({ email: member.email, role: "viewer" });
    expect(call(2).url).toBe("/api/v1/projects/prj%2Fa/members/u%2F1");
    expect(call(2).init?.method).toBe("PATCH");
    expect(JSON.parse(String(call(2).init?.body))).toEqual({ role: "member" });
    expect(call(3).url).toBe(call(2).url);
    expect(call(3).init?.method).toBe("DELETE");
    for (const i of [1, 2, 3]) {
      expect(call(i).headers["x-jekimo-csrf-token"]).toBe("csrf-1");
      expect(call(i).init?.credentials).toBe("same-origin");
    }
  });
  it("uses admin endpoints with CSRF and discards duplicate raw tokens from link responses", async () => {
    const account = { ...SESSION.user, status: "active" };
    const invitation = { id: "i/1", email: "new@example.test" };
    const reset = { id: "r/1", user_id: "u/1" };
    const { api, call } = setup([
      json(200, SESSION),
      json(200, { users: [account] }),
      json(200, { user: account }),
      json(201, { invitation, link: "/invite#token=synthetic", token: "synthetic" }),
      json(200, { invitations: [invitation] }),
      new Response(null, { status: 204 }),
      json(201, { reset, link: "/reset-password#token=synthetic-reset", token: "synthetic-reset" }),
    ]);
    await api.getSession();
    expect(await api.listUsers()).toEqual([account]);
    await api.updateUser("u/1", { status: "deactivated" });
    expect(call(2).url).toBe("/api/v1/users/u%2F1");
    expect(JSON.parse(String(call(2).init?.body))).toEqual({ status: "deactivated" });
    expect(await api.createInvitation("new@example.test", "member")).toEqual({
      invitation,
      link: "/invite#token=synthetic",
    });
    expect(JSON.parse(String(call(3).init?.body))).toEqual({ email: "new@example.test", instance_role: "member" });
    expect(await api.listInvitations()).toEqual([invitation]);
    await api.revokeInvitation("i/1");
    expect(call(5).url).toBe("/api/v1/invitations/i%2F1");
    expect(call(5).init?.method).toBe("DELETE");
    expect(await api.createPasswordReset("u/1")).toEqual({ reset, link: "/reset-password#token=synthetic-reset" });
    expect(call(6).url).toBe("/api/v1/users/u%2F1/password-reset");
    for (const i of [2, 3, 5, 6]) expect(call(i).headers["x-jekimo-csrf-token"]).toBe("csrf-1");
  });
});
