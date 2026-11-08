/**
 * Per-project export over real HTTP against PostgreSQL: a project of several
 * thousand events streams in bounded pages, every line validates in stored
 * form, another project's rows never appear, and the export is audit-logged.
 * Skipped unless JEKIMO_DATABASE_URL is set.
 */

import { createGunzip } from "node:zlib";
import { validateEvent } from "@jekimo/event-schema";
import {
  type AppendEvent,
  INGEST_QUEUE,
  type IngestJob,
  PostgresEventStore,
  PostgresMetadataRepository,
  PostgresQueue,
} from "@jekimo/storage-postgres";
import { createTestDatabase, hasDatabase, type TestDatabase } from "@jekimo/storage-postgres/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { CSRF_HEADER, SESSION_COOKIE } from "../src/constants/index.js";
import { fakeHasher, PASSWORD, SETUP_TOKEN } from "./helpers.js";

const TOTAL = 6_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = (n: number) =>
  `01JBQ4Z3H8X9T2K7M${[...n.toString(32).padStart(9, "0")].map((d) => CROCKFORD[parseInt(d, 32)]).join("")}`;

function stored(projectId: string, n: number, receivedAt: Date, message = "synthetic export event"): AppendEvent {
  return {
    receivedAt,
    keyId: "0123456789AB",
    event: {
      schema_version: 1,
      event_id: ulid(n),
      project_id: projectId,
      timestamp: receivedAt.toISOString(),
      kind: "log",
      severity: "info",
      message,
      fingerprint: "fp-export",
      context: { request_id: `req_${n}` },
    },
  };
}

describe.skipIf(!hasDatabase)("export on PostgreSQL", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let base: string;
  let metadata: PostgresMetadataRepository;
  let admin: Record<string, string>;
  let adminId: string;
  let projectId: string;
  let setupKey: string;
  let dev: Record<string, string>;
  let devProject: string;
  /** Rows returned by each event-store query. */
  const pages: number[] = [];

  async function login(email: string, password: string): Promise<Record<string, string>> {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
    expect(res.statusCode).toBe(200);
    const cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
    return { cookie, [CSRF_HEADER]: res.json().csrf_token };
  }

  /** Reads the body chunk by chunk and parses each complete line as it arrives. */
  async function readLines(res: Response, gzip = false): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let rest = "";
    const onText = (text: string) => {
      const parts = (rest + text).split("\n");
      rest = parts.pop() ?? "";
      for (const line of parts) out.push(JSON.parse(line) as Record<string, unknown>);
    };
    const body = res.body!;
    if (gzip) {
      const gunzip = createGunzip();
      gunzip.setEncoding("utf8");
      const done = new Promise<void>((resolve, reject) => {
        gunzip.on("data", onText).on("end", resolve).on("error", reject);
      });
      for await (const chunk of body) gunzip.write(chunk);
      gunzip.end();
      await done;
    } else {
      const decoder = new TextDecoder();
      for await (const chunk of body) onText(decoder.decode(chunk, { stream: true }));
    }
    expect(rest).toBe("");
    return out;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    metadata = new PostgresMetadataRepository(db.pool);
    const counting = {
      query: async (...args: unknown[]) => {
        const result = await (db.pool.query as (...a: unknown[]) => Promise<{ rows: unknown[] }>)(...args);
        pages.push(result.rows.length);
        return result;
      },
    } as unknown as typeof db.pool;
    const events = new PostgresEventStore(db.pool);
    app = await buildApp({
      metadata,
      events: new PostgresEventStore(counting),
      queue: new PostgresQueue<IngestJob>(db.pool, INGEST_QUEUE),
      hasher: fakeHasher,
      setupToken: SETUP_TOKEN,
    });
    base = await app.listen({ port: 0, host: "127.0.0.1" });
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_token: SETUP_TOKEN, email: "admin@example.test", password: PASSWORD, project_name: "Billing" },
    });
    expect(setup.statusCode).toBe(201);
    adminId = setup.json().user.id;
    projectId = setup.json().project.id;
    setupKey = setup.json().ingestion_key.key;
    admin = await login("admin@example.test", PASSWORD);

    const invite = await app.inject({
      method: "POST",
      url: "/api/v1/invitations",
      headers: admin,
      payload: { email: "dev@example.test" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: { token: invite.json().token, password: PASSWORD },
    });
    dev = await login("dev@example.test", PASSWORD);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: dev,
      payload: { name: "Dev sandbox" },
    });
    expect(created.statusCode).toBe(201);
    devProject = created.json().project.id;

    const start = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const mine = Array.from({ length: TOTAL }, (_, i) => stored(projectId, TOTAL - i, new Date(start + i * 20)));
    const theirs = Array.from({ length: 500 }, (_, i) =>
      stored(devProject, i + 1, new Date(start + i * 200), "dev project event"),
    );
    for (let i = 0; i < mine.length; i += 2000) await events.appendEvents(projectId, mine.slice(i, i + 2000));
    await events.appendEvents(devProject, theirs);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  it("streams a large project as stored-form NDJSON in bounded pages", async () => {
    pages.length = 0;
    const res = await fetch(`${base}/api/v1/projects/${projectId}/export`, { headers: { cookie: admin.cookie! } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = await readLines(res);
    expect(lines).toHaveLength(TOTAL);
    for (const line of lines) {
      expect(validateEvent(line, { mode: "stored" })).toMatchObject({ ok: true, warnings: [] });
      expect(line.project_id).toBe(projectId);
    }
    expect(lines.some((l) => l.message === "dev project event")).toBe(false);
    const eventPages = pages.filter((n) => n > 0);
    expect(Math.max(...eventPages)).toBeLessThanOrEqual(500);
    expect(eventPages.length).toBeGreaterThanOrEqual(TOTAL / 500);
  }, 60_000);

  it("streams gzip with the same content", async () => {
    const res = await fetch(`${base}/api/v1/projects/${projectId}/export?compression=gzip`, {
      headers: { cookie: admin.cookie! },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(await readLines(res, true)).toHaveLength(TOTAL);
  }, 60_000);

  it("scopes the export to the project in the URL; changing the id gets 404", async () => {
    const other = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/export`,
      headers: dev,
    });
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe("not_found");
    const own = await fetch(`${base}/api/v1/projects/${devProject}/export`, { headers: { cookie: dev.cookie! } });
    const lines = await readLines(own);
    expect(lines).toHaveLength(500);
    expect(lines.every((l) => l.project_id === devProject && l.message === "dev project event")).toBe(true);
  });

  it("audit-logs each export with actor and range, and never exports secrets", async () => {
    const to = new Date().toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/export?to=${to}`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    const [entry] = await metadata.listAudit(
      { userId: adminId, instanceRole: "admin" },
      { action: "data.exported", limit: 1 },
    );
    expect(entry).toMatchObject({
      actorUserId: adminId,
      action: "data.exported",
      projectId,
      details: { from: null, to, compression: "none" },
    });
    expect(JSON.stringify(entry)).not.toContain("synthetic export event");
    const { rows } = await db.pool.query<{ password_hash: string }>("SELECT password_hash FROM users");
    for (const secret of [setupKey, admin.cookie!.split("=")[1]!, ...rows.map((r) => r.password_hash)]) {
      expect(res.body).not.toContain(secret);
    }
  });
});
