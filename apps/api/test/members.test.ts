/**
 * Membership rules (docs/access-model.md, "Membership rules" and "Custom
 * roles"): no escalation, the last project admin, isolation between
 * projects, and audit entries for every change.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type Harness, harness, projectWithKey, type SignedIn, setRole, signIn } from "./helpers.js";

let h: Harness;
let owner: SignedIn;
let projectId: string;

beforeEach(async () => {
  h = await harness();
  owner = await signIn(h, "owner@example.test");
  ({ projectId } = await projectWithKey(h, owner, "prj_members"));
});

const members = (id = projectId) => `/api/v1/projects/${id}/members`;

describe("adding members", () => {
  it("adds an instance user by email with a role and audit-logs it", async () => {
    const dev = await signIn(h, "dev@example.test");
    const res = await h.app.inject({
      method: "POST",
      url: members(),
      headers: owner.headers,
      payload: { email: "DEV@example.test", role: "Member" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().member).toMatchObject({ user_id: dev.userId, email: "dev@example.test", role: "member" });
    expect(h.metadata.audit.at(-1)).toMatchObject({
      action: "member.added",
      actorUserId: owner.userId,
      targetId: dev.userId,
      projectId,
      details: { role: "member" },
    });

    const list = await h.app.inject({ method: "GET", url: members(), headers: dev.headers });
    expect(list.json().members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      ["owner@example.test", "admin"],
      ["dev@example.test", "member"],
    ]);
  });

  it("answers stable error codes", async () => {
    const dev = await signIn(h, "dev@example.test");
    const post = (payload: Record<string, unknown>) =>
      h.app.inject({ method: "POST", url: members(), headers: owner.headers, payload });
    const code = async (payload: Record<string, unknown>) => {
      const res = await post(payload);
      return [res.statusCode, res.json().error?.code];
    };
    expect(await code({ email: "nobody@example.test", role: "viewer" })).toEqual([404, "user_not_found"]);
    expect(await code({ user_id: "not-a-uuid", role: "viewer" })).toEqual([404, "user_not_found"]);
    expect(await code({ email: "dev@example.test", role: "owner" })).toEqual([400, "unknown_role"]);
    expect(await code({ email: "dev@example.test" })).toEqual([400, "invalid_request"]);
    expect(await code({ role: "viewer" })).toEqual([400, "invalid_request"]);
    expect((await post({ user_id: dev.userId, role: "viewer" })).statusCode).toBe(201);
    expect(await code({ user_id: dev.userId, role: "viewer" })).toEqual([409, "already_member"]);
  });

  it("lists the project's roles with permissions and member counts", async () => {
    h.metadata.defineRole(projectId, "Triage", ["project.read", "issues.manage"]);
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/roles`,
      headers: owner.headers,
    });
    expect(res.json().roles.map((r: { name: string; built_in: boolean; member_count: number }) => r)).toEqual([
      expect.objectContaining({ name: "admin", built_in: true, member_count: 1 }),
      expect.objectContaining({ name: "member", built_in: true, member_count: 0 }),
      expect.objectContaining({ name: "viewer", built_in: true, member_count: 0, permissions: ["project.read"] }),
      expect.objectContaining({ name: "Triage", built_in: false, permissions: ["project.read", "issues.manage"] }),
    ]);
  });
});

describe("no escalation", () => {
  let manager: SignedIn;
  let dev: SignedIn;

  beforeEach(async () => {
    manager = await signIn(h, "manager@example.test");
    setRole(h, projectId, manager.userId, "people", ["project.read", "members.manage", "issues.manage"]);
    dev = await signIn(h, "dev@example.test");
  });

  it("lets a member manager grant only roles whose permissions they hold", async () => {
    const grant = (role: string) =>
      h.app.inject({
        method: "POST",
        url: members(),
        headers: manager.headers,
        payload: { user_id: dev.userId, role },
      });
    const denied = await grant("member"); // includes data.export, which the manager lacks
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("role_escalation");
    expect((await grant("admin")).statusCode).toBe(403);
    expect((await grant("people")).statusCode).toBe(201); // their own role
  });

  it("does not let a member manager change or remove someone with more permissions", async () => {
    const admin = await signIn(h, "second-admin@example.test");
    setRole(h, projectId, admin.userId, "admin");
    const demote = await h.app.inject({
      method: "PATCH",
      url: `${members()}/${admin.userId}`,
      headers: manager.headers,
      payload: { role: "viewer" },
    });
    expect([demote.statusCode, demote.json().error.code]).toEqual([403, "role_escalation"]);
    const remove = await h.app.inject({
      method: "DELETE",
      url: `${members()}/${admin.userId}`,
      headers: manager.headers,
    });
    expect(remove.statusCode).toBe(403);
    expect(h.metadata.members.get(projectId)!.get(admin.userId)).toBe("admin");
  });

  it("does not let anyone promote themselves past their permissions", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `${members()}/${manager.userId}`,
      headers: manager.headers,
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("last admin", () => {
  it("keeps at least one admin per project", async () => {
    const demote = await h.app.inject({
      method: "PATCH",
      url: `${members()}/${owner.userId}`,
      headers: owner.headers,
      payload: { role: "viewer" },
    });
    expect([demote.statusCode, demote.json().error.code]).toEqual([409, "last_admin"]);
    const remove = await h.app.inject({
      method: "DELETE",
      url: `${members()}/${owner.userId}`,
      headers: owner.headers,
    });
    expect([remove.statusCode, remove.json().error.code]).toEqual([409, "last_admin"]);
    // Only instance admins may force it.
    const forced = await h.app.inject({
      method: "DELETE",
      url: `${members()}/${owner.userId}?force=true`,
      headers: owner.headers,
    });
    expect(forced.statusCode).toBe(403);
    expect(h.metadata.members.get(projectId)!.get(owner.userId)).toBe("admin");
  });

  it("lets an admin step down once another admin exists", async () => {
    const second = await signIn(h, "second@example.test");
    setRole(h, projectId, second.userId, "admin");
    const res = await h.app.inject({
      method: "PATCH",
      url: `${members()}/${owner.userId}`,
      headers: owner.headers,
      payload: { role: "viewer" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.metadata.audit.at(-1)).toMatchObject({
      action: "member.role_changed",
      targetId: owner.userId,
      details: { before: "admin", after: "viewer" },
    });
  });

  it("lets an instance admin remove the last admin on purpose, flagged in the audit log", async () => {
    const root = await signIn(h, "root@example.test", "admin");
    const plain = await h.app.inject({ method: "DELETE", url: `${members()}/${owner.userId}`, headers: root.headers });
    expect(plain.statusCode).toBe(409);
    const forced = await h.app.inject({
      method: "DELETE",
      url: `${members()}/${owner.userId}?force=true`,
      headers: root.headers,
    });
    expect(forced.statusCode).toBe(204);
    expect(h.metadata.members.get(projectId)!.has(owner.userId)).toBe(false);
    expect(h.metadata.audit.at(-1)).toMatchObject({
      action: "member.removed",
      actorUserId: root.userId,
      viaInstanceAdmin: true,
      details: { role: "admin", last_admin_removed: true },
    });
    // The project is still reachable through instance authority.
    const project = await h.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: root.headers });
    expect(project.statusCode).toBe(200);
  });
});

describe("isolation", () => {
  it("cannot reach members of another project through this project's URL", async () => {
    const other = await signIn(h, "other@example.test");
    await projectWithKey(h, other, "prj_elsewhere");
    // `other` is not a member of prj_members, so changing them here is member_not_found.
    const res = await h.app.inject({
      method: "PATCH",
      url: `${members()}/${other.userId}`,
      headers: owner.headers,
      payload: { role: "viewer" },
    });
    expect([res.statusCode, res.json().error.code]).toEqual([404, "member_not_found"]);
    expect(h.metadata.members.get("prj_elsewhere")!.get(other.userId)).toBe("admin");
    // And the other project itself is a 404 for the owner, like a project that does not exist.
    const guess = await h.app.inject({ method: "GET", url: members("prj_elsewhere"), headers: owner.headers });
    const missing = await h.app.inject({ method: "GET", url: members("prj_missing"), headers: owner.headers });
    expect(guess.statusCode).toBe(404);
    expect(guess.json()).toEqual(missing.json());
  });

  it("removing a member takes their access away on the next request", async () => {
    const dev = await signIn(h, "dev@example.test");
    setRole(h, projectId, dev.userId, "viewer");
    const before = await h.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: dev.headers });
    expect(before.statusCode).toBe(200);
    const remove = await h.app.inject({ method: "DELETE", url: `${members()}/${dev.userId}`, headers: owner.headers });
    expect(remove.statusCode).toBe(204);
    const after = await h.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: dev.headers });
    expect(after.statusCode).toBe(404);
  });
});

describe("project settings", () => {
  it("changes name, retention, and sample rate, audit-logging before and after", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: owner.headers,
      payload: { name: "Renamed", retention_days: 14, sample_rate: 0.5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().project).toMatchObject({ name: "Renamed", retention_days: 14, sample_rate: 0.5 });
    expect(h.metadata.audit.at(-1)).toMatchObject({
      action: "project.settings_updated",
      projectId,
      details: {
        changes: {
          name: { before: "Test project", after: "Renamed" },
          retention_days: { before: 30, after: 14 },
          sample_rate: { before: 1, after: 0.5 },
        },
      },
    });
  });

  it("validates settings", async () => {
    for (const payload of [{}, { name: "" }, { retention_days: 0 }, { retention_days: 4000 }, { sample_rate: 2 }]) {
      const res = await h.app.inject({
        method: "PATCH",
        url: `/api/v1/projects/${projectId}`,
        headers: owner.headers,
        payload,
      });
      expect({ payload, status: res.statusCode }).toEqual({ payload, status: 400 });
    }
  });
});
