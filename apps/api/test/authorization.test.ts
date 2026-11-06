/**
 * Route authorization matrix (docs/access-model.md, "Authorization
 * enforcement", rule 3): every /projects/:id route against every built-in
 * role, a custom role with each single permission, an instance admin who is
 * not a member, and a user with no access.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { PROJECT_PERMISSIONS, type ProjectPermission } from "@jekimo/event-schema";
import { harness, projectWithKey, setRole, signIn, type Harness, type SignedIn } from "./helpers.js";

interface Route {
  method: "GET" | "POST";
  url: (id: string) => string;
  permission: ProjectPermission;
  ok: number;
}

const ROUTES: Route[] = [
  { method: "GET", url: (id) => `/api/v1/projects/${id}`, permission: "project.read", ok: 200 },
  { method: "GET", url: (id) => `/api/v1/projects/${id}/events`, permission: "project.read", ok: 200 },
  { method: "POST", url: (id) => `/api/v1/projects/${id}/keys`, permission: "keys.manage", ok: 201 },
];

const BUILT_IN: Record<string, ProjectPermission[]> = {
  admin: [...PROJECT_PERMISSIONS],
  member: ["project.read", "issues.manage", "data.export"],
  viewer: ["project.read"],
};

let h: Harness;
let owner: SignedIn;
let projectId: string;
let key: string;
const principals: { name: string; user: SignedIn; permissions: ProjectPermission[] | "none" }[] = [];

beforeAll(async () => {
  h = await harness();
  owner = await signIn(h, "owner@example.test");
  ({ projectId, key } = await projectWithKey(h, owner, "prj_matrix"));
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
  principals.push({ name: "instance admin, not a member", user: await signIn(h, "instance-admin@example.test", "admin"), permissions: [...PROJECT_PERMISSIONS] });
  principals.push({ name: "user with no access", user: await signIn(h, "outsider@example.test"), permissions: "none" });
});

describe.each(ROUTES)("$method $permission route", (route) => {
  it.each(Array.from({ length: 2 + Object.keys(BUILT_IN).length + PROJECT_PERMISSIONS.length }, (_, i) => i))("principal %#", async (i) => {
    const p = principals[i]!;
    const res = await h.app.inject({ method: route.method, url: route.url(projectId), headers: p.user.headers, ...(route.method === "POST" && { payload: {} }) });
    const expected = p.permissions === "none" ? 404 : p.permissions.includes(route.permission) ? route.ok : 403;
    expect({ principal: p.name, status: res.statusCode }).toEqual({ principal: p.name, status: expected });
  });
});

describe("isolation", () => {
  it("answers 404 for a project that does not exist, same as one the user cannot see", async () => {
    const outsider = principals.find((p) => p.permissions === "none")!.user;
    const missing = await h.app.inject({ method: "GET", url: "/api/v1/projects/prj_does_not_exist", headers: outsider.headers });
    const hidden = await h.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: outsider.headers });
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
    for (const url of ["/api/v1/projects", `/api/v1/projects/${projectId}/events`, "/api/v1/auth/session"]) {
      const res = await h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });
      expect(res.statusCode).toBe(401);
    }
    // Not even alongside a valid session.
    const both = await h.app.inject({ method: "GET", url: "/api/v1/projects", headers: { ...owner.headers, authorization: `Bearer ${key}` } });
    expect(both.statusCode).toBe(401);
  });

  it("requires a session for every project route", async () => {
    for (const route of ROUTES) {
      const res = await h.app.inject({ method: route.method, url: route.url(projectId) });
      expect(res.statusCode).toBe(401);
    }
  });

  it("requires the CSRF header to create a key", async () => {
    const res = await h.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/keys`, headers: { cookie: owner.cookie }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf_failed");
  });
});

describe("projects and keys", () => {
  it("creates a project with built-in roles and makes the creator its admin", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/v1/projects", headers: owner.headers, payload: { name: "Billing" } });
    expect(res.statusCode).toBe(201);
    const project = res.json().project;
    expect(project).toMatchObject({ name: "Billing", retention_days: 30, sample_rate: 1 });
    expect(project.id).toMatch(/^prj_[a-z0-9]{16}$/);
    expect([...h.metadata.roles.get(project.id)!.keys()]).toEqual(["admin", "member", "viewer"]);
    expect(h.metadata.members.get(project.id)!.get(owner.userId)).toBe("admin");
  });

  it("validates project input", async () => {
    expect((await h.app.inject({ method: "POST", url: "/api/v1/projects", headers: owner.headers, payload: { name: "" } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "POST", url: "/api/v1/projects", headers: owner.headers, payload: { name: "x", retention_days: 0 } })).statusCode).toBe(400);
  });

  it("returns a new key once, stores only its hash, and audit-logs the key_id", async () => {
    const res = await h.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/keys`, headers: owner.headers, payload: { name: "production" } });
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
    for (const q of ["?severity=loud", "?limit=0", "?limit=501", "?from=yesterday", "?from=2026-11-05T10:00:00Z&to=2026-11-05T09:00:00Z", "?cursor=bogus"]) {
      const res = await h.app.inject({ method: "GET", url: url + q, headers: owner.headers });
      expect({ q, status: res.statusCode }).toEqual({ q, status: 400 });
    }
  });
});
