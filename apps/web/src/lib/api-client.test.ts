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

  it("treats a closed setup as not required", async () => {
    const { api } = setup([json(404, { error: { code: "not_found", message: "not found" } })]);
    await expect(api.setupRequired()).resolves.toBe(false);
  });
});
