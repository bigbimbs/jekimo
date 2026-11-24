import { PostgresMetadataRepository } from "@jekimo/storage-postgres";
import { MemoryEventStore, MemoryQueue } from "@jekimo/storage-postgres/memory";
import { createTestDatabase, hasDatabase, type TestDatabase } from "@jekimo/storage-postgres/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { totpAt } from "../src/two-factor.js";
import { fakeHasher, PASSWORD } from "./helpers.js";

const KEY = Buffer.alloc(32, 4).toString("base64");

describe.skipIf(!hasDatabase)("two-factor on PostgreSQL", () => {
  let db: TestDatabase;
  let apps: FastifyInstance[];
  let metadata: PostgresMetadataRepository;
  let headers: Record<string, string>;
  let userId: string;
  let now: Date;
  const code = (secret: string) => totpAt(secret, Math.floor(now.getTime() / 30_000));
  const advance = () => {
    now = new Date(now.getTime() + 30_000);
  };
  const login = (app: FastifyInstance, otp?: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "pg-admin@example.test", password: PASSWORD, ...(otp && { code: otp }) },
    });
  const post = (path: string, payload: Record<string, unknown>) =>
    apps[0]!.inject({ method: "POST", url: `/api/v1/auth/two-factor/${path}`, headers, payload });
  async function enroll() {
    const start = await post("setup", { password: PASSWORD });
    expect(start.statusCode, start.body).toBe(200);
    const secret = start.json().secret as string;
    const enabled = await post("enable", { code: code(secret) });
    expect(enabled.statusCode, enabled.body).toBe(200);
    return { secret, codes: enabled.json().recovery_codes as string[] };
  }
  beforeEach(async () => {
    db = await createTestDatabase();
    now = new Date();
    metadata = new PostgresMetadataRepository(db.pool);
    userId = (await metadata.createFirstAdmin({
      email: "pg-admin@example.test",
      passwordHash: await fakeHasher.hash(PASSWORD),
    }))!.id;
    apps = await Promise.all(
      [0, 1].map(() =>
        buildApp({
          metadata: new PostgresMetadataRepository(db.pool),
          events: new MemoryEventStore(),
          queue: new MemoryQueue(),
          hasher: fakeHasher,
          config: { mfaEncryptionKey: KEY },
          clock: () => now,
        }),
      ),
    );
    const signedIn = await login(apps[0]!);
    expect(signedIn.statusCode).toBe(200);
    headers = {
      cookie: `jekimo_session=${signedIn.cookies[0]?.value}`,
      "x-jekimo-csrf-token": signedIn.json().csrf_token,
    };
  });
  afterEach(async () => {
    await Promise.all((apps ?? []).map((a) => a.close()));
    await db?.close();
  });

  it("allows only one concurrent use of a TOTP across API processes", async () => {
    const { secret } = await enroll();
    advance();
    const results = await Promise.all(apps.map((app) => login(app, code(secret))));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    const state = await metadata.getTwoFactor(userId);
    expect(state.secret).not.toContain(secret);
    expect(state.lastStep).toBe(Math.floor(now.getTime() / 30_000));
  });

  it("allows only one concurrent use of a recovery code and persists consumption", async () => {
    const { codes } = await enroll();
    const results = await Promise.all(apps.map((app) => login(app, codes[0])));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect((await new PostgresMetadataRepository(db.pool).getTwoFactor(userId)).recoveryHashes).toHaveLength(7);
    expect((await login(apps[0]!, codes[0])).statusCode).toBe(400);
  });

  it("persists enforcement, refuses disable, and keeps policy after operator recovery", async () => {
    const { secret } = await enroll();
    advance();
    const policy = await apps[0]!.inject({
      method: "PUT",
      url: "/api/v1/admin/security",
      headers,
      payload: { required: true, password: PASSWORD, code: code(secret) },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(await new PostgresMetadataRepository(db.pool).isTwoFactorRequired()).toBe(true);
    advance();
    expect((await post("disable", { password: PASSWORD, code: code(secret) })).json().error.code).toBe(
      "two_factor_required_by_admin",
    );
    expect((await metadata.mutateTwoFactor({ kind: "reset", userId, now })).ok).toBe(true);
    const oldSession = await apps[1]!.inject({ method: "GET", url: "/api/v1/projects", headers });
    expect(oldSession.statusCode).toBe(401);
    const limited = await login(apps[1]!);
    expect(limited.json().two_factor).toMatchObject({ required: true, enabled: false });
    const denied = await apps[1]!.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie: `jekimo_session=${limited.cookies[0]?.value}` },
    });
    expect(denied.json().error.code).toBe("two_factor_enrollment_required");
  });

  it("serializes failed-code attempts across processes and preserves lockout", async () => {
    const { secret } = await enroll();
    await Promise.all(Array.from({ length: 12 }, (_, i) => login(apps[i % 2]!, "invalid")));
    expect((await metadata.getTwoFactor(userId)).failures).toBe(10);
    advance();
    expect((await login(apps[1]!, code(secret))).statusCode).toBe(429);
  });
});
