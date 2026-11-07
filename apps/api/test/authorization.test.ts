/**
 * Route authorization matrix (docs/access-model.md, "Authorization
 * enforcement", rule 3): every /projects/:id route against every built-in
 * role, a custom role with each single permission, an instance admin who is
 * not a member, and a user with no access.
 */

import { PROJECT_PERMISSIONS, type ProjectPermission } from "@jekimo/event-schema";
import { beforeAll, describe, expect, it } from "vitest";
import { generateIngestionKey } from "../src/keys.js";
import { type Harness, harness, projectWithKey, type SignedIn, setRole, signIn, storeEvent } from "./helpers.js";

interface Route {
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  permission: ProjectPermission;
  ok: number;
  /** Puts the project in the state the route needs and returns the request. Runs before every call. */
  request: (id: string) => Promise<{ url: string; payload?: Record<string, unknown> }>;
}

const MATRIX_EVENT_ID = "01JBQ4Z3H8X9T2K7M5N6P8R9SV";

let h: Harness;
let owner: SignedIn;
let projectId: string;
let key: string;
/** A viewer the membership routes add, change, and remove. */
let target: SignedIn;
const principals: { name: string; user: SignedIn; permissions: ProjectPermission[] | "none" }[] = [];

/** A fresh active key, created directly in storage with instance authority. */
async function freshKey(id: string): Promise<string> {
  const access = await h.metadata.resolveProjectAccess({ userId: owner.userId, instanceRole: "admin" }, id);
  const k = generateIngestionKey();
  await h.metadata.createIngestionKey(access!, { keyId: k.keyId, keyHash: k.keyHash, name: "matrix" });
  return k.keyId;
}

const at = (url: string, payload?: Record<string, unknown>) => async () => ({ url, ...(payload && { payload }) });

const ROUTES: Route[] = [
  {
    name: "GET project",
    method: "GET",
    permission: "project.read",
    ok: 200,
    request: (id) => at(`/api/v1/projects/${id}`)(),
  },
  {
    name: "PATCH project",
    method: "PATCH",
    permission: "settings.manage",
    ok: 200,
    request: (id) => at(`/api/v1/projects/${id}`, { name: "Matrix project" })(),
  },
  {
    name: "GET events",
    method: "GET",
    permission: "project.read",
    ok: 200,
    request: (id) => at(`/api/v1/projects/${id}/events`)(),
  },
  {
    name: "GET event",
    method: "GET",
    permission: "project.read",
    ok: 200,
    request: (id) => at(`/api/v1/projects/${id}/events/${MATRIX_EVENT_ID}`)(),
  },
  {
    name: "POST keys",
    method: "POST",
    permission: "keys.manage",
    ok: 201,
    request: (id) => at(`/api/v1/projects/${id}/keys`, {})(),
  },
  {
    name: "GET keys",
    method: "GET",
    permission: "keys.manage",
    ok: 200,
    request: (id) => at(`/api/v1/projects/${id}/keys`)(),
  },
  {
    name: "POST rotate key",
    method: "POST",
    permission: "keys.manage",
    ok: 201,
    request: async (id) => ({ url: `/api/v1/projects/${id}/keys/${await freshKey(id)}/rotate`, payload: {} }),
  },
  {
    name: "POST revoke key",
    method: "POST",
    permission: "keys.manage",
    ok: 200,
    request: async (id) => ({ url: `/api/v1/projects/${id}/keys/${await freshKey(id)}/revoke`, payload: {} }),
  },
  {
    name: "GET roles",
    method: "GET",
    permission: "project.read",
    ok: 200,
    request: (id) => at(`/api/v1/projects/${id}/roles`)(),
  },
  {
    name: "GET members",
    method: "GET",
    permission: "project.read",
    ok: 200,
    request: (id) => at(`/api/v1/projects/${id}/members`)(),
  },
  {
    name: "POST member",
    method: "POST",
    permission: "members.manage",
    ok: 201,
    request: async (id) => {
      h.metadata.members.get(id)!.delete(target.userId);
      return { url: `/api/v1/projects/${id}/members`, payload: { user_id: target.userId, role: "viewer" } };
    },
  },
  {
    name: "PATCH member",
    method: "PATCH",
    permission: "members.manage",
    ok: 200,
    request: async (id) => {
      setRole(h, id, target.userId, "viewer");
      return { url: `/api/v1/projects/${id}/members/${target.userId}`, payload: { role: "reader" } };
    },
  },
  {
    name: "DELETE member",
    method: "DELETE",
    permission: "members.manage",
    ok: 204,
    request: async (id) => {
      setRole(h, id, target.userId, "viewer");
      return { url: `/api/v1/projects/${id}/members/${target.userId}` };
    },
  },
];

const BUILT_IN: Record<string, ProjectPermission[]> = {
  admin: [...PROJECT_PERMISSIONS],
  member: ["project.read", "issues.manage", "data.export"],
  viewer: ["project.read"],
};

beforeAll(async () => {
  h = await harness();
  owner = await signIn(h, "owner@example.test");
  ({ projectId, key } = await projectWithKey(h, owner, "prj_matrix"));
  await storeEvent(h, projectId, { event_id: MATRIX_EVENT_ID });
  // A custom role every principal with members.manage may assign (it grants only project.read).
  h.metadata.defineRole(projectId, "reader", ["project.read"]);
  target = await signIn(h, "target@example.test");
  setRole(h, projectId, target.userId, "viewer");
  for (const [role, permissions] of Object.entries(BUILT_IN)) {
    const user = await signIn(h, `${role}@example.test`);
    setRole(h, projectId, user.userId, role);
    principals.push({ name: `built-in ${role}`, user, permissions });
  }
  for (const p of PROJECT_PERMISSIONS) {
    const user = await signIn(h, `custom-${p}@example.test`);
    const permissions: ProjectPermission[] = p === "project.read" ? ["project.read"] : ["project.read", p];
    setRole(h, projectId, user.userId, `custom ${p}`, permissions);
    principals.push({ name: `custom role with ${p}`, user, permissions });
  }
  principals.push({
    name: "instance admin, not a member",
    user: await signIn(h, "instance-admin@example.test", "admin"),
    permissions: [...PROJECT_PERMISSIONS],
  });
  principals.push({ name: "user with no access", user: await signIn(h, "outsider@example.test"), permissions: "none" });
});

describe.each(ROUTES)("$name ($permission)", (route) => {
  it.each(Array.from({ length: 2 + Object.keys(BUILT_IN).length + PROJECT_PERMISSIONS.length }, (_, i) => i))(
    "principal %#",
    async (i) => {
      const p = principals[i]!;
      const { url, payload } = await route.request(projectId);
      const res = await h.app.inject({
        method: route.method,
        url,
        headers: p.user.headers,
        ...(payload && { payload }),
      });
      const expected = p.permissions === "none" ? 404 : p.permissions.includes(route.permission) ? route.ok : 403;
      expect({ principal: p.name, status: res.statusCode }).toEqual({ principal: p.name, status: expected });
    },
  );
});

describe("isolation", () => {
  it("answers 404 for a project that does not exist, same as one the user cannot see", async () => {
    const outsider = principals.find((p) => p.permissions === "none")!.user;
    const missing = await h.app.inject({
      method: "GET",
      url: "/api/v1/projects/prj_does_not_exist",
      headers: outsider.headers,
    });
    const hidden = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: outsider.headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    expect(missing.json()).toEqual(hidden.json());
  });

  it("lists only the projects a member belongs to", async () => {
    const outsider = principals.find((p) => p.permissions === "none")!.user;
    const res = await h.app.inject({ method: "GET", url: "/api/v1/projects", headers: outsider.headers });
    expect(res.json()).toEqual({ projects: [] });
    const mine = await h.app.inject({ method: "GET", url: "/api/v1/projects", headers: owner.headers });
    expect(mine.json().projects.map((p: { id: string }) => p.id)).toEqual([projectId]);
  });

  it("never accepts an ingestion key on session endpoints", async () => {
    for (const url of [
      "/api/v1/projects",
      `/api/v1/projects/${projectId}/events`,
      `/api/v1/projects/${projectId}/events/${MATRIX_EVENT_ID}`,
      "/api/v1/auth/session",
    ]) {
      const res = await h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });
      expect(res.statusCode).toBe(401);
    }
    // Not even alongside a valid session.
    const both = await h.app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { ...owner.headers, authorization: `Bearer ${key}` },
    });
    expect(both.statusCode).toBe(401);
  });

  it("requires a session for every project route", async () => {
    for (const route of ROUTES) {
      const { url } = await route.request(projectId);
      const res = await h.app.inject({ method: route.method, url });
      expect({ route: route.name, status: res.statusCode }).toEqual({ route: route.name, status: 401 });
    }
  });

  it("answers 404 when a member guesses another project's id, on every project route", async () => {
    const other = await signIn(h, "other-owner@example.test");
    await projectWithKey(h, other, "prj_other");
    for (const route of ROUTES) {
      const { url, payload } = await route.request("prj_other");
      const res = await h.app.inject({
        method: route.method,
        url,
        headers: owner.headers,
        ...(payload && { payload }),
      });
      expect({ route: route.name, status: res.statusCode }).toEqual({ route: route.name, status: 404 });
    }
  });

  it("requires the CSRF header to create a key", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/keys`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf_failed");
  });
});

describe("projects and keys", () => {
  it("creates a project with built-in roles and makes the creator its admin", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: owner.headers,
      payload: { name: "Billing" },
    });
    expect(res.statusCode).toBe(201);
    const project = res.json().project;
    expect(project).toMatchObject({ name: "Billing", retention_days: 30, sample_rate: 1 });
    expect(project.id).toMatch(/^prj_[a-z0-9]{16}$/);
    expect([...h.metadata.roles.get(project.id)!.keys()]).toEqual(["admin", "member", "viewer"]);
    expect(h.metadata.members.get(project.id)!.get(owner.userId)).toBe("admin");
  });

  it("validates project input", async () => {
    expect(
      (await h.app.inject({ method: "POST", url: "/api/v1/projects", headers: owner.headers, payload: { name: "" } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner.headers,
          payload: { name: "x", retention_days: 0 },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("returns a new key once, stores only its hash, and audit-logs the key_id", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/keys`,
      headers: owner.headers,
      payload: { name: "production" },
    });
    expect(res.statusCode).toBe(201);
    const { key: fullKey, key_id } = res.json();
    expect(fullKey).toMatch(new RegExp(`^jk_${key_id}_[a-z0-9]{32}$`));
    const stored = h.metadata.keys.find((k) => k.keyId === key_id)!;
    expect(JSON.stringify({ ...stored, keyHash: [...stored.keyHash] })).not.toContain(fullKey.slice(16));
    const audit = h.metadata.audit.filter((a) => a.action === "ingestion_key.created").at(-1)!;
    expect(audit).toMatchObject({ targetId: key_id, projectId, actorUserId: owner.userId });
    expect(JSON.stringify(h.metadata.audit)).not.toContain(fullKey);
  });

  it("validates event query parameters", async () => {
    const url = `/api/v1/projects/${projectId}/events`;
    for (const q of [
      "?severity=loud",
      "?limit=0",
      "?limit=501",
      "?from=yesterday",
      "?from=2026-11-05T10:00:00Z&to=2026-11-05T09:00:00Z",
      "?cursor=bogus",
      "?kind=crash",
      "?kind=",
      "?environment=",
      `?environment=${"x".repeat(129)}`,
      "?environment=a&environment=b",
      `?release=${"x".repeat(129)}`,
      `?fingerprint=${"x".repeat(257)}`,
      "?q=",
      "?q=%21%3F%2E",
      `?q=${"x".repeat(257)}`,
    ]) {
      const res = await h.app.inject({ method: "GET", url: url + q, headers: owner.headers });
      expect({ q, status: res.statusCode }).toEqual({ q, status: 400 });
    }
  });
});
