/**
 * The vertical slice against a real PostgreSQL: setup (first admin, project,
 * and key), sign in, ingest, let the worker drain the queue, and read the
 * event back. Skipped unless JEKIMO_DATABASE_URL is set.
 */

import {
  checkDatabase,
  checkQueue,
  INGEST_QUEUE,
  type IngestJob,
  PostgresEventStore,
  PostgresIngestLimitStore,
  PostgresMetadataRepository,
  PostgresQueue,
} from "@jekimo/storage-postgres";
import { createTestDatabase, hasDatabase, type TestDatabase } from "@jekimo/storage-postgres/testing";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "../../worker/src/worker.js";
import { buildApp } from "../src/app.js";
import { SESSION_COOKIE } from "../src/constants/index.js";
import { fakeHasher, ingestEvent, PASSWORD, SETUP_TOKEN } from "./helpers.js";

describe.skipIf(!hasDatabase)("vertical slice on PostgreSQL", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let worker: Worker;

  beforeAll(async () => {
    db = await createTestDatabase();
    const metadata = new PostgresMetadataRepository(db.pool);
    const events = new PostgresEventStore(db.pool);
    const queue = new PostgresQueue<IngestJob>(db.pool, INGEST_QUEUE);
    app = await buildApp({
      metadata,
      events,
      queue,
      limits: new PostgresIngestLimitStore(db.pool),
      hasher: fakeHasher,
      setupToken: SETUP_TOKEN,
      readiness: { database: () => checkDatabase(db.pool), queue: () => checkQueue(db.pool) },
    });
    worker = new Worker({
      queue,
      metadata,
      events,
      log: pino({ level: "silent" }),
      batchSize: 10,
      pollMs: 10,
      expiryIntervalMs: 60_000,
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  it("is ready once the database and queue are reachable", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { database: "ok", queue: "ok" } });
  });

  it("goes from setup to a stored, queryable event", async () => {
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_token: SETUP_TOKEN, email: "admin@example.test", password: PASSWORD, project_name: "Billing" },
    });
    expect(setup.statusCode).toBe(201);
    const projectId = setup.json().project.id as string;
    const key = setup.json().ingestion_key.key as string;
    const closed = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_token: SETUP_TOKEN, email: "again@example.test", password: PASSWORD, project_name: "Other" },
    });
    expect(closed.statusCode).toBe(404);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.test", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const cookie = `${SESSION_COOKIE}=${login.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;

    const projects = await app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie } });
    expect(projects.json().projects).toEqual([expect.objectContaining({ id: projectId, name: "Billing" })]);

    const now = new Date().toISOString();
    const body = {
      sent_at: now,
      events: [
        ingestEvent({
          timestamp: now,
          kind: "exception",
          severity: "error",
          message: "Synthetic failure",
          exception: {
            type: "SyntheticError",
            value: "boom",
            stacktrace: "SyntheticError: boom\n    at run (/app/src/run.ts:1:1)",
          },
        }),
        ingestEvent({ event_id: "01JBQ50A6D2V8W4Y1Z3X5C7B9N", timestamp: now }),
      ],
    };
    const ingest = await app.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: body,
    });
    expect(ingest.statusCode).toBe(202);
    expect(ingest.json().accepted).toHaveLength(2);
    expect(ingest.headers["x-ratelimit-limit"]).toBe("1000");
    expect(Number(ingest.headers["x-ratelimit-remaining"])).toBeLessThanOrEqual(998);
    // A retry of the same request is acknowledged and stores nothing new.
    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/ingest",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: body,
    });
    expect(retry.json().accepted).toHaveLength(2);

    expect(await worker.drainOnce()).toBe(2);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?severity=error`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    const { events } = read.json();
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({
      project_id: projectId,
      kind: "exception",
      exception: { type: "SyntheticError" },
    });
    expect(events[0].event.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const all = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/events`, headers: { cookie } });
    expect(all.json().events).toHaveLength(2);

    const issues = await db.pool.query("SELECT event_count FROM issues WHERE project_id = $1 ORDER BY event_count", [
      projectId,
    ]);
    expect(issues.rows.map((r) => Number(r.event_count))).toEqual([1, 1]);

    // The audit log names the key, never the secret.
    const audit = await db.pool.query("SELECT action, target_id, details FROM audit_log");
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["user.created", "auth.login", "project.created", "ingestion_key.created"]),
    );
    expect(JSON.stringify(audit.rows)).not.toContain(key);
    const stored = await db.pool.query("SELECT key_hash FROM ingestion_keys");
    expect(stored.rows[0].key_hash).toHaveLength(32);
  });
});
