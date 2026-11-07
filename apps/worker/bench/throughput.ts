/**
 * Worker throughput benchmark. Creates a throwaway schema in the database
 * named by JEKIMO_DATABASE_URL, enqueues synthetic ingest jobs, drains them
 * with the real worker, prints the result, and drops the schema.
 *
 *   JEKIMO_DATABASE_URL=postgres://... npm run bench -w @jekimo/worker
 *
 * Settings (environment): BENCH_JOBS (default 200), BENCH_EVENTS_PER_JOB
 * (default 100, the ingest maximum), JEKIMO_WORKER_BATCH_SIZE (default 10).
 * See apps/worker/README.md, "Throughput benchmark".
 */

import { randomBytes } from "node:crypto";
import os from "node:os";
import type { EventEnvelope } from "@jekimo/event-schema";
import {
  type IngestJob,
  PostgresEventStore,
  PostgresMetadataRepository,
  PostgresQueue,
  runMigrations,
} from "@jekimo/storage-postgres";
import { createTestDatabase } from "@jekimo/storage-postgres/testing";
import pino from "pino";
import { loadWorkerConfig } from "../src/config.js";
import { Worker } from "../src/worker.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function positive(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

function ulid(time: number): string {
  let t = "";
  for (let n = time, i = 0; i < 10; i++, n = Math.floor(n / 32)) t = CROCKFORD[n % 32] + t;
  return t + Array.from(randomBytes(16), (b) => CROCKFORD[b % 32]).join("");
}

/** A mix of logs and exceptions across a few dozen fingerprints. */
function syntheticEvent(n: number, now: Date): EventEnvelope {
  const base = {
    schema_version: 1 as const,
    event_id: ulid(now.getTime()),
    timestamp: now.toISOString(),
    service: "bench-api",
    environment: "bench",
    release: "1.0.0",
    context: { request_id: `req_${n}`, route: `/orders/${n % 40}`, authorization: "synthetic" },
    attributes: { order_id: n, retry_count: n % 3, cart: { items: n % 7, currency: "EUR" } },
  };
  if (n % 10 === 0) {
    return {
      ...base,
      kind: "exception",
      severity: "error",
      message: `order ${n} failed`,
      exception: {
        type: `BenchError${n % 20}`,
        value: `order ${n} failed`,
        stacktrace: `BenchError${n % 20}: order ${n} failed\n    at handle (/srv/app/orders.js:${n % 90}:7)\n    at run (/srv/app/server.js:12:3)`,
      },
    };
  }
  return { ...base, kind: "log", severity: "info", message: `order ${n} shipped in ${n % 500} ms` };
}

async function main(): Promise<void> {
  const jobs = positive("BENCH_JOBS", 200);
  const perJob = Math.min(100, positive("BENCH_EVENTS_PER_JOB", 100));
  const { batchSize } = loadWorkerConfig();
  const db = await createTestDatabase();
  try {
    await runMigrations(db.pool);
    const metadata = new PostgresMetadataRepository(db.pool);
    const admin = await metadata.createFirstAdmin({ email: "bench@example.test", passwordHash: "$argon2id$synthetic" });
    if (!admin) throw new Error("could not create the benchmark admin");
    const actor = { userId: admin.id, instanceRole: "admin" as const };
    await metadata.createProject(actor, { id: "prj_bench", name: "Bench", retentionDays: 30 });
    const access = await metadata.resolveProjectAccess(actor, "prj_bench");
    if (!access) throw new Error("no access to the benchmark project");
    await metadata.setRedactionRules(access, { keys: ["order_id"], patterns: ["^x-internal-"] });

    const queue = new PostgresQueue<IngestJob>(db.pool, "ingest", { maxDepth: jobs + 1 });
    const now = new Date();
    for (let j = 0; j < jobs; j++) {
      await queue.enqueue({
        project_id: "prj_bench",
        key_id: "0123456789AB",
        received_at: now.toISOString(),
        events: Array.from({ length: perJob }, (_, i) => syntheticEvent(j * perJob + i, now)),
      });
    }

    const store = new PostgresEventStore(db.pool);
    const worker = new Worker({
      queue,
      metadata,
      events: store,
      log: pino({ level: "silent" }),
      batchSize,
      pollMs: 50,
      expiryIntervalMs: 60 * 60_000,
    });
    const started = process.hrtime.bigint();
    while ((await worker.drainOnce()) > 0) {}
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;

    const stats = await queue.stats();
    if (stats.depth !== 0 || stats.dead !== 0) throw new Error(`queue not drained: ${JSON.stringify(stats)}`);
    const events = jobs * perJob;
    const stored = (await store.summarizeFingerprints("prj_bench")).reduce((sum, f) => sum + f.eventCount, 0);
    if (stored !== events) throw new Error(`stored ${stored} of ${events} events`);
    const perSecond = events / seconds;
    console.log(
      JSON.stringify(
        {
          jobs,
          events_per_job: perJob,
          batch_size: batchSize,
          events,
          seconds: Number(seconds.toFixed(2)),
          events_per_second: Math.round(perSecond),
          events_per_month_at_this_rate: Math.round(perSecond * 30 * 24 * 3600),
          host: {
            platform: `${os.platform()} ${os.arch()}`,
            cpus: os.cpus().length,
            memory_gib: Math.round(os.totalmem() / 2 ** 30),
            node: process.version,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "benchmark failed");
  process.exit(1);
});
