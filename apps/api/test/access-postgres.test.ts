/**
 * Accounts, memberships, keys, and the audit log against a real PostgreSQL:
 * the same rules the in-memory tests check, through the HTTP API and
 * PostgresMetadataRepository. Skipped unless JEKIMO_DATABASE_URL is set.
 */

import {
  INGEST_QUEUE,
  type IngestJob,
  PostgresEventStore,
  PostgresMetadataRepository,
  PostgresQueue,
} from "@jekimo/storage-postgres";
import { createTestDatabase, hasDatabase, type TestDatabase } from "@jekimo/storage-postgres/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAdminCommand } from "../src/admin-command.js";
import { buildApp } from "../src/app.js";
import { CSRF_HEADER, SESSION_COOKIE } from "../src/constants/index.js";
import { fakeHasher, ingestEvent, PASSWORD, SETUP_TOKEN } from "./helpers.js";

const NEW_PASSWORD = "another-synthetic-passphrase";
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!hasDatabase)("access model on PostgreSQL", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let metadata: PostgresMetadataRepository;
  let admin: Record<string, string>;
  let adminId: string;
  let projectId: string;
  let setupKey: string;
  let setupKeyId: string;

  async function login(email: string, password: string): Promise<{ status: number; headers: Record<string, string> }> {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
    if (res.statusCode !== 200) return { status: res.statusCode, headers: {} };
    const cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
    return { status: 200, headers: { cookie, [CSRF_HEADER]: res.json().csrf_token } };
  }

  function ingest(key: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: { events: [ingestEvent()] },
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    metadata = new PostgresMetadataRepository(db.pool);
    app = await buildApp({
      metadata,
      events: new PostgresEventStore(db.pool),
      queue: new PostgresQueue<IngestJob>(db.pool, INGEST_QUEUE),
      hasher: fakeHasher,
      setupToken: SETUP_TOKEN,
    });
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_token: SETUP_TOKEN, email: "admin@example.test", password: PASSWORD, project_name: "Billing" },
    });
    expect(setup.statusCode).toBe(201);
    adminId = setup.json().user.id;
    projectId = setup.json().project.id;
    setupKey = setup.json().ingestion_key.key;
    setupKeyId = setup.json().ingestion_key.key_id;
    admin = (await login("admin@example.test", PASSWORD)).headers;
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  let devId: string;
  let dev: Record<string, string>;

  it("invites a user, who accepts once and signs in", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/invitations",
      headers: admin,
      payload: { email: "dev@example.test" },
    });
    expect(res.statusCode).toBe(201);
    const { token, invitation } = res.json();
    const listed = await app.inject({ method: "GET", url: "/api/v1/invitations", headers: admin });
    expect(listed.json().invitations).toEqual([invitation]);
    const accept = () =>
      app.inject({ method: "POST", url: "/api/v1/invitations/accept", payload: { token, password: NEW_PASSWORD } });
    const accepted = await accept();
    expect(accepted.statusCode).toBe(201);
    devId = accepted.json().user.id;
    expect((await accept()).json().error.code).toBe("invalid_token");
    const signedIn = await login("dev@example.test", NEW_PASSWORD);
    expect(signedIn.status).toBe(200);
    dev = signedIn.headers;
    const taken = await app.inject({
      method: "POST",
      url: "/api/v1/invitations",
      headers: admin,
      payload: { email: "DEV@example.test" },
    });
    expect(taken.json().error.code).toBe("email_taken");
  });

  it("adds, changes, and removes members with the escalation and last-admin rules", async () => {
    const members = `/api/v1/projects/${projectId}/members`;
    expect((await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: dev })).statusCode).toBe(
      404,
    );
    const add = await app.inject({
      method: "POST",
      url: members,
      headers: admin,
      payload: { email: "dev@example.test", role: "viewer" },
    });
    expect(add.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: dev })).statusCode).toBe(
      200,
    );
    const again = await app.inject({
      method: "POST",
      url: members,
      headers: admin,
      payload: { user_id: devId, role: "viewer" },
    });
    expect(again.json().error.code).toBe("already_member");

    // A viewer cannot manage members at all.
    const denied = await app.inject({
      method: "PATCH",
      url: `${members}/${devId}`,
      headers: dev,
      payload: { role: "admin" },
    });
    expect(denied.statusCode).toBe(403);

    // The setup admin is the last project admin; even an instance admin needs force.
    const demote = await app.inject({
      method: "PATCH",
      url: `${members}/${adminId}`,
      headers: admin,
      payload: { role: "member" },
    });
    expect(demote.json().error.code).toBe("last_admin");
    const promote = await app.inject({
      method: "PATCH",
      url: `${members}/${devId}`,
      headers: admin,
      payload: { role: "ADMIN" },
    });
    expect(promote.json().member.role).toBe("admin");
    expect(
      (await app.inject({ method: "PATCH", url: `${members}/${adminId}`, headers: admin, payload: { role: "member" } }))
        .statusCode,
    ).toBe(200);
    // Now dev is the last admin; dev (not an instance admin) cannot leave or force.
    const leave = await app.inject({ method: "DELETE", url: `${members}/${devId}`, headers: dev });
    expect(leave.json().error.code).toBe("last_admin");
    const force = await app.inject({ method: "DELETE", url: `${members}/${devId}?force=true`, headers: dev });
    expect(force.statusCode).toBe(403);
    const forced = await app.inject({ method: "DELETE", url: `${members}/${devId}?force=true`, headers: admin });
    expect(forced.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: members, headers: admin });
    expect(list.json().members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      ["admin@example.test", "member"],
    ]);
    const roles = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/roles`, headers: admin });
    expect(roles.json().roles.map((r: { name: string; member_count: number }) => [r.name, r.member_count])).toEqual([
      ["admin", 0],
      ["member", 1],
      ["viewer", 0],
    ]);
  });

  it("updates project settings", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: admin,
      payload: { retention_days: 14, sample_rate: 0.25 },
    });
    expect(res.json().project).toMatchObject({ retention_days: 14, sample_rate: 0.25, name: "Billing" });
  });

  it("lists, rotates, and revokes keys; revoked and expired keys get 401", async () => {
    const keys = `/api/v1/projects/${projectId}/keys`;
    const list = await app.inject({ method: "GET", url: keys, headers: admin });
    expect(list.json().keys).toEqual([
      expect.objectContaining({ key_id: setupKeyId, name: "setup", status: "active" }),
    ]);
    expect(list.body).not.toContain(setupKey);

    const rotated = await app.inject({
      method: "POST",
      url: `${keys}/${setupKeyId}/rotate`,
      headers: admin,
      payload: { grace_hours: 1 },
    });
    expect(rotated.statusCode).toBe(201);
    const newKey = rotated.json().key as string;
    expect((await ingest(setupKey)).statusCode).toBe(202);
    expect((await ingest(newKey)).statusCode).toBe(202);
    const rotateAgain = await app.inject({
      method: "POST",
      url: `${keys}/${setupKeyId}/rotate`,
      headers: admin,
      payload: {},
    });
    expect(rotateAgain.json().error.code).toBe("key_not_active");

    const revoke = await app.inject({
      method: "POST",
      url: `${keys}/${setupKeyId}/revoke`,
      headers: admin,
      payload: {},
    });
    expect(revoke.json().key.status).toBe("revoked");
    expect((await ingest(setupKey)).statusCode).toBe(401);
    expect((await ingest(newKey)).statusCode).toBe(202);

    const zero = await app.inject({
      method: "POST",
      url: `${keys}/${rotated.json().key_id}/rotate`,
      headers: admin,
      payload: { grace_hours: 0 },
    });
    expect((await ingest(newKey)).statusCode).toBe(401);
    expect((await ingest(zero.json().key)).statusCode).toBe(202);
  });

  it("resets passwords from an admin link and from the command line, ending sessions", async () => {
    const reset = await app.inject({ method: "POST", url: `/api/v1/users/${devId}/password-reset`, headers: admin });
    const { token } = reset.json();
    const done = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: { token, password: "a-third-synthetic-passphrase" },
    });
    expect(done.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: dev })).statusCode).toBe(401);
    dev = (await login("dev@example.test", "a-third-synthetic-passphrase")).headers;

    const out: string[] = [];
    const code = await runAdminCommand(["admin", "reset-password", "admin@example.test"], {
      metadata,
      inviteExpiryDays: 7,
      publicUrl: "https://jekimo.example.test",
      clock: () => new Date(),
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    const cliToken = out.find((l) => l.includes("#token="))!.split("#token=")[1]!;
    const cliDone = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: { token: cliToken, password: NEW_PASSWORD },
    });
    expect(cliDone.statusCode).toBe(200);
    admin = (await login("admin@example.test", NEW_PASSWORD)).headers;
  });

  it("changes a password, revoking other sessions, and manages sessions", async () => {
    const second = (await login("dev@example.test", "a-third-synthetic-passphrase")).headers;
    const sessions = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: dev });
    expect(sessions.json().sessions).toHaveLength(2);
    const change = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: dev,
      payload: { current_password: "a-third-synthetic-passphrase", new_password: NEW_PASSWORD },
    });
    expect(change.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: second })).statusCode).toBe(401);
    const mine = (await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: dev })).json().sessions;
    expect(mine).toEqual([expect.objectContaining({ current: true })]);
    const strangers = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${mine[0].id}`,
      headers: admin,
    });
    expect(strangers.statusCode).toBe(404);
    const revoked = await app.inject({ method: "DELETE", url: `/api/v1/users/${devId}/sessions`, headers: admin });
    expect(revoked.json()).toEqual({ revoked: 1 });
  });

  it("keeps one active instance admin and deactivates users", async () => {
    const demote = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${adminId}`,
      headers: admin,
      payload: { status: "deactivated" },
    });
    expect(demote.json().error.code).toBe("last_admin");
    const deactivate = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${devId}`,
      headers: admin,
      payload: { status: "deactivated" },
    });
    expect(deactivate.json().user.status).toBe("deactivated");
    expect((await login("dev@example.test", NEW_PASSWORD)).status).toBe(401);
    const users = await app.inject({ method: "GET", url: "/api/v1/users", headers: admin });
    expect(users.json().users.map((u: { email: string; status: string }) => [u.email, u.status])).toEqual([
      ["admin@example.test", "active"],
      ["dev@example.test", "deactivated"],
    ]);
  });

  it("lists the audit log with filters and paging, without secrets", async () => {
    const all = await app.inject({ method: "GET", url: "/api/v1/audit-log?limit=500", headers: admin });
    const actions = all.json().entries.map((e: { action: string }) => e.action) as string[];
    for (const action of [
      "user.created",
      "project.created",
      "ingestion_key.created",
      "user.invited",
      "user.activated",
      "member.added",
      "member.role_changed",
      "member.removed",
      "project.settings_updated",
      "ingestion_key.rotated",
      "ingestion_key.revoked",
      "user.password_reset_link_created",
      "user.password_reset",
      "user.password_changed",
      "session.revoked",
      "user.deactivated",
      "auth.login",
    ]) {
      expect(actions).toContain(action);
    }
    expect(all.body).not.toContain(setupKey);
    expect(all.body).not.toContain(NEW_PASSWORD);

    const page = await app.inject({ method: "GET", url: "/api/v1/audit-log?limit=3", headers: admin });
    const next = await app.inject({
      method: "GET",
      url: `/api/v1/audit-log?limit=3&cursor=${page.json().next_cursor}`,
      headers: admin,
    });
    const ids = [...page.json().entries, ...next.json().entries].map((e: { id: string }) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(6);

    const forced = await app.inject({
      method: "GET",
      url: `/api/v1/audit-log?action=member.removed&actor=${adminId}`,
      headers: admin,
    });
    expect(forced.json().entries).toEqual([
      expect.objectContaining({ project_id: projectId, details: { role: "admin", last_admin_removed: true } }),
    ]);
    const future = await app.inject({
      method: "GET",
      url: `/api/v1/audit-log?from=${encodeURIComponent(new Date(Date.now() + DAY_MS).toISOString())}`,
      headers: admin,
    });
    expect(future.json().entries).toEqual([]);
  });

  it("keeps audit entries about a deleted project and prunes by age", async () => {
    await db.pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/audit-log?action=project.created&limit=500",
      headers: admin,
    });
    expect(res.json().entries.map((e: { project_id: string }) => e.project_id)).toContain(projectId);
    await db.pool.query("UPDATE audit_log SET occurred_at = now() - interval '400 days' WHERE action = 'user.created'");
    expect(await metadata.pruneAudit(new Date(Date.now() - 365 * DAY_MS))).toBe(1);
    const left = await app.inject({ method: "GET", url: "/api/v1/audit-log?action=user.created", headers: admin });
    expect(left.json().entries).toEqual([]);
  });
});
