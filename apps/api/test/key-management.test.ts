/**
 * Ingestion key listing, rotation with a grace period, and revocation
 * (docs/ingestion-protocol.md, "Authentication", "Rules"), and that an
 * ingestion key reaches no route but ingest.
 */

import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { fakeHasher, type Harness, harness, ingestEvent, projectWithKey, type SignedIn, signIn } from "./helpers.js";

const HOUR_MS = 60 * 60 * 1000;

let h: Harness;
let owner: SignedIn;
let projectId: string;
let key: string;
let keyId: string;

beforeEach(async () => {
  h = await harness();
  owner = await signIn(h, "owner@example.test");
  ({ projectId, key, keyId } = await projectWithKey(h, owner, "prj_keys"));
});

function ingest(token: string) {
  return h.app.inject({
    method: "POST",
    url: "/api/v1/ingest",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: { events: [ingestEvent()] },
  });
}

const keysUrl = (suffix = "") => `/api/v1/projects/${projectId}/keys${suffix}`;

describe("listing keys", () => {
  it("returns key_id, name, creation time, and status, never the secret or its hash", async () => {
    const res = await h.app.inject({ method: "GET", url: keysUrl(), headers: owner.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys).toEqual([
      {
        key_id: keyId,
        name: "test",
        status: "active",
        created_at: h.now.value.toISOString(),
        created_by: owner.userId,
        expires_at: null,
        revoked_at: null,
      },
    ]);
    expect(res.body).not.toContain(key.slice(16));
    expect(res.body).not.toMatch(/hash/i);
  });
});

describe("rotation", () => {
  it("issues a new key once and keeps the old one working for the grace period", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: keysUrl(`/${keyId}/rotate`),
      headers: owner.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const rotated = res.json();
    expect(rotated.key).toMatch(new RegExp(`^jk_${rotated.key_id}_[a-z0-9]{32}$`));
    expect(rotated.name).toBe("test");
    expect(rotated.rotated).toMatchObject({
      key_id: keyId,
      status: "rotating",
      expires_at: new Date(h.now.value.getTime() + 24 * HOUR_MS).toISOString(),
    });

    expect((await ingest(rotated.key)).statusCode).toBe(202);
    expect((await ingest(key)).statusCode).toBe(202);
    h.now.value = new Date(h.now.value.getTime() + 24 * HOUR_MS);
    expect((await ingest(key)).statusCode).toBe(401);
    expect((await ingest(rotated.key)).statusCode).toBe(202);

    const list = await h.app.inject({ method: "GET", url: keysUrl(), headers: owner.headers });
    expect(list.json().keys.map((k: { key_id: string; status: string }) => [k.key_id, k.status])).toEqual(
      expect.arrayContaining([
        [keyId, "expired"],
        [rotated.key_id, "active"],
      ]),
    );

    const audit = h.metadata.audit.find((a) => a.action === "ingestion_key.rotated")!;
    expect(audit).toMatchObject({ targetId: keyId, projectId, details: { new_key_id: rotated.key_id } });
    expect(JSON.stringify(h.metadata.audit)).not.toContain(rotated.key);
  });

  it("accepts a grace period per request, including none", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: keysUrl(`/${keyId}/rotate`),
      headers: owner.headers,
      payload: { grace_hours: 0 },
    });
    expect(res.statusCode).toBe(201);
    expect((await ingest(key)).statusCode).toBe(401);
    for (const grace_hours of [-1, 1.5, 721, "24"]) {
      const bad = await h.app.inject({
        method: "POST",
        url: keysUrl(`/${res.json().key_id}/rotate`),
        headers: owner.headers,
        payload: { grace_hours },
      });
      expect({ grace_hours, status: bad.statusCode }).toEqual({ grace_hours, status: 400 });
    }
  });

  it("uses JEKIMO_KEY_ROTATION_GRACE_HOURS as the default", async () => {
    h = await harness({ config: { keyRotationGraceHours: 2 } });
    owner = await signIn(h, "owner@example.test");
    ({ projectId, key, keyId } = await projectWithKey(h, owner, "prj_keys"));
    const res = await h.app.inject({
      method: "POST",
      url: keysUrl(`/${keyId}/rotate`),
      headers: owner.headers,
      payload: {},
    });
    expect(res.json().rotated.expires_at).toBe(new Date(h.now.value.getTime() + 2 * HOUR_MS).toISOString());
  });

  it("rotates only active keys", async () => {
    await h.app.inject({ method: "POST", url: keysUrl(`/${keyId}/rotate`), headers: owner.headers, payload: {} });
    const again = await h.app.inject({
      method: "POST",
      url: keysUrl(`/${keyId}/rotate`),
      headers: owner.headers,
      payload: {},
    });
    expect([again.statusCode, again.json().error.code]).toEqual([409, "key_not_active"]);
  });
});

describe("revocation", () => {
  it("takes effect on the next ingest request with the same 401 as an unknown key", async () => {
    expect((await ingest(key)).statusCode).toBe(202);
    const res = await h.app.inject({
      method: "POST",
      url: keysUrl(`/${keyId}/revoke`),
      headers: owner.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().key).toMatchObject({ key_id: keyId, status: "revoked", revoked_at: h.now.value.toISOString() });
    const revoked = await ingest(key);
    const unknown = await ingest("jk_0123456789AB_abcdefghijklmnopqrstuvwxyz012345");
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json()).toEqual(unknown.json());
    expect(h.metadata.audit.at(-1)).toMatchObject({
      action: "ingestion_key.revoked",
      actorUserId: owner.userId,
      targetId: keyId,
      projectId,
    });
    expect(JSON.stringify(h.metadata.audit)).not.toContain(key);

    const again = await h.app.inject({
      method: "POST",
      url: keysUrl(`/${keyId}/revoke`),
      headers: owner.headers,
      payload: {},
    });
    expect([again.statusCode, again.json().error.code]).toEqual([409, "key_already_revoked"]);
  });

  it("can revoke a key that is rotating, ending its grace period", async () => {
    await h.app.inject({ method: "POST", url: keysUrl(`/${keyId}/rotate`), headers: owner.headers, payload: {} });
    await h.app.inject({ method: "POST", url: keysUrl(`/${keyId}/revoke`), headers: owner.headers, payload: {} });
    expect((await ingest(key)).statusCode).toBe(401);
  });

  it("does not find a key of another project through this project's URL", async () => {
    const other = await signIn(h, "other@example.test");
    const elsewhere = await projectWithKey(h, other, "prj_elsewhere");
    for (const action of ["rotate", "revoke"]) {
      const res = await h.app.inject({
        method: "POST",
        url: keysUrl(`/${elsewhere.keyId}/${action}`),
        headers: owner.headers,
        payload: {},
      });
      expect([res.statusCode, res.json().error.code]).toEqual([404, "key_not_found"]);
    }
    expect((await ingest(elsewhere.key)).statusCode).toBe(202);
  });
});

describe("ingestion keys outside ingest", () => {
  it("are rejected with 401 by every route except ingest and the health checks", async () => {
    const routes: { method: string; url: string }[] = [];
    const app: FastifyInstance = await buildApp({
      metadata: h.metadata,
      events: h.events,
      queue: h.queue,
      hasher: fakeHasher,
      setupToken: "synthetic-setup-token-for-tests",
      clock: () => h.now.value,
      onRoute: (r) => {
        for (const method of [r.method].flat()) if (method !== "HEAD") routes.push({ method, url: r.url });
      },
    });
    const open = new Set(["/api/v1/ingest", "/healthz", "/readyz"]);
    const checked = routes.filter((r) => !open.has(r.url));
    expect(checked.length).toBeGreaterThan(25);
    for (const r of checked) {
      const url = r.url
        .replace(":id", projectId)
        .replace(":key_id", keyId)
        .replace(":user_id", owner.userId)
        .replace(/:[a-z_]+/g, "00000000-0000-4000-8000-000000000000");
      const res = await app.inject({
        method: r.method as "GET",
        url,
        // Even alongside a valid session and CSRF token.
        headers: { ...owner.headers, authorization: `Bearer ${key}` },
        ...(r.method !== "GET" && r.method !== "DELETE" && { payload: {} }),
      });
      expect({ route: `${r.method} ${r.url}`, status: res.statusCode }).toEqual({
        route: `${r.method} ${r.url}`,
        status: 401,
      });
    }
  });
});
