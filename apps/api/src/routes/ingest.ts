/**
 * POST /api/v1/ingest, server side of docs/ingestion-protocol.md.
 *
 * Runs in its own encapsulated plugin with its own body parser and error
 * handler, and with no session middleware: a session cookie cannot reach it
 * and the bearer ingestion key is the only credential it accepts.
 */

import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  bearerToken,
  INGEST_ERROR_STATUS,
  INGEST_PATH,
  type IngestErrorCode,
  LIMITS,
  validateIngestRequest,
} from "@jekimo/event-schema";
import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  type DiskMonitor,
  type IngestJob,
  type IngestLimitStore,
  type IngestLimits,
  type MetadataRepository,
  type Queue,
  QueueFullError,
  secondsUntilNextMinute,
  secondsUntilNextUtcDay,
} from "@jekimo/storage-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { keyIdForLookup, verifyIngestionKey } from "../keys.js";

const gunzipAsync = promisify(gunzip);
const JSON_CONTENT_TYPE = /^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i;
const RETRY_AFTER_SECONDS = 5;
/** A full queue drains at the worker's pace, so clients wait longer. */
const QUEUE_FULL_RETRY_AFTER_SECONDS = 30;
/** docs/retention.md, "Disk safety": the full level answers 503 with Retry-After: 60. */
const DISK_FULL_RETRY_AFTER_SECONDS = 60;

class IngestError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

declare module "fastify" {
  interface FastifyRequest {
    ingest?: { projectId: string; keyId: string; receivedAt: Date; limits?: IngestLimits };
  }
}

export interface IngestRouteOptions {
  metadata: MetadataRepository;
  queue: Queue<IngestJob>;
  clock: () => Date;
  maxBodyBytes?: number;
  /** Rate limits and quotas (processing steps 2 and 3). Absent: no limits, for tests only. */
  limits?: IngestLimitStore;
  /** Instance-wide defaults for projects without their own settings. */
  limitDefaults?: IngestLimits;
  /** Free space on the database volume. Absent: not checked, for tests only. */
  disk?: DiskMonitor;
}

/** docs/ingestion-protocol.md, "Headers on every response". */
function setRateLimitHeaders(reply: FastifyReply, limits: IngestLimits, minuteEvents: number, now: Date): void {
  reply.header("x-ratelimit-limit", String(limits.ratePerMinute));
  reply.header("x-ratelimit-remaining", String(Math.max(0, limits.ratePerMinute - minuteEvents)));
  reply.header("x-ratelimit-reset", String(secondsUntilNextMinute(now)));
}

function rateLimited(limits: IngestLimits, now: Date): IngestError {
  return new IngestError(
    "rate_limited",
    `project exceeded ${limits.ratePerMinute} events per minute`,
    secondsUntilNextMinute(now),
  );
}

/** Over quota until midnight UTC (docs/retention.md, "Quotas"). */
function quotaExceeded(limits: IngestLimits, now: Date): IngestError {
  return new IngestError(
    "quota_exceeded",
    `project exceeded its quota of ${limits.eventsPerDay} events per day`,
    secondsUntilNextUtcDay(now),
  );
}

/** Reads the body stream, stopping as soon as it passes `limit` bytes. */
function readLimited(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        stream.removeAllListeners("data");
        stream.resume();
        reject(new IngestError("payload_too_large", `request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export async function ingestRoutes(app: FastifyInstance, opts: IngestRouteOptions): Promise<void> {
  const maxBody = opts.maxBodyBytes ?? LIMITS.MAX_BATCH_BYTES;
  const limitDefaults: IngestLimits = opts.limitDefaults ?? {
    ratePerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
    eventsPerDay: null,
  };
  const utf8 = new TextDecoder("utf-8", { fatal: true });

  app.setErrorHandler((err, request, reply) => {
    let e: IngestError;
    if (err instanceof IngestError) {
      e = err;
    } else {
      // Storage trouble while authenticating or parsing. Never log the body.
      request.log.error({ err: { type: (err as Error).name, message: (err as Error).message } }, "ingest failed");
      e = new IngestError("unavailable", "the server could not accept events; retry later", RETRY_AFTER_SECONDS);
    }
    if (e.retryAfter !== undefined) reply.header("retry-after", String(e.retryAfter));
    const body = {
      error: { code: e.code, message: e.message, ...(e.retryAfter !== undefined && { retry_after: e.retryAfter }) },
    };
    reply.status(INGEST_ERROR_STATUS[e.code]).send(body);
  });

  // The ingest endpoint parses its own bodies: limits before reading, gzip,
  // strict UTF-8, and error codes from the protocol.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (request: FastifyRequest, payload, done) => {
    void (async () => {
      const raw = await readLimited(payload, maxBody);
      let body = raw;
      if (request.headers["content-encoding"]?.toLowerCase() === "gzip") {
        try {
          body = await gunzipAsync(raw, { maxOutputLength: maxBody });
        } catch (err) {
          if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
            throw new IngestError("payload_too_large", `decompressed body exceeds ${maxBody} bytes`);
          }
          throw new IngestError("invalid_json", "request body is not valid gzip");
        }
      }
      let text: string;
      try {
        text = utf8.decode(body);
      } catch {
        throw new IngestError("invalid_json", "request body is not valid UTF-8");
      }
      try {
        return { json: JSON.parse(text) as unknown, bytes: body.length };
      } catch {
        throw new IngestError("invalid_json", "request body is not valid JSON");
      }
    })().then(
      (parsed) => done(null, parsed),
      (err: Error) => done(err),
    );
  });

  // Step 1 of "Processing": authenticate before looking at the body.
  app.addHook("onRequest", async (request, reply) => {
    const receivedAt = opts.clock();
    const token = bearerToken(request.headers.authorization);
    const { keyId, wellFormed } = keyIdForLookup(token);
    // Malformed and unknown keys take the same path: one lookup, one hash, one comparison.
    const record = await opts.metadata.findIngestionKey(keyId);
    const matches = verifyIngestionKey(token, record);
    if (
      !wellFormed ||
      !record ||
      !matches ||
      record.revokedAt !== null ||
      (record.expiresAt !== null && record.expiresAt <= receivedAt)
    ) {
      throw new IngestError("unauthorized", "missing, malformed, unknown, or revoked ingestion key");
    }
    // The project is known from here on, so every response carries the
    // X-RateLimit-* headers. A 401 has none: no project was identified.
    let limits: IngestLimits | undefined;
    let usage: { minuteEvents: number; dayEvents: number } | undefined;
    if (opts.limits) {
      const read = await opts.limits.read(record.projectId, receivedAt);
      if (!read) throw new IngestError("unauthorized", "missing, malformed, unknown, or revoked ingestion key");
      limits = {
        ratePerMinute: read.rateLimitPerMinute ?? limitDefaults.ratePerMinute,
        eventsPerDay: read.eventsPerDay ?? limitDefaults.eventsPerDay,
      };
      usage = read;
      setRateLimitHeaders(reply, limits, read.minuteEvents, receivedAt);
    }
    if (record.projectDisabled) throw new IngestError("project_disabled", "project is disabled");
    // Disk safety: refuse new events before the database volume fills. The
    // monitor fails closed, so an unknown free space also refuses.
    if (opts.disk && (await opts.disk.status()).level === "full") {
      throw new IngestError(
        "unavailable",
        "the server is low on disk space; retry later",
        DISK_FULL_RETRY_AFTER_SECONDS,
      );
    }
    // Steps 2 and 3 before the body is read: a full minute refuses at once.
    // A project over quota whose minute still has room is read so its events
    // can be counted as dropped, and the charge after parsing refuses it.
    if (limits && usage && usage.minuteEvents >= limits.ratePerMinute) {
      const overQuota = limits.eventsPerDay !== null && usage.dayEvents >= limits.eventsPerDay;
      throw overQuota ? quotaExceeded(limits, receivedAt) : rateLimited(limits, receivedAt);
    }
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !JSON_CONTENT_TYPE.test(contentType)) {
      throw new IngestError("unsupported_media_type", "Content-Type must be application/json");
    }
    const encoding = request.headers["content-encoding"]?.toLowerCase();
    if (encoding !== undefined && encoding !== "gzip" && encoding !== "identity") {
      throw new IngestError("unsupported_media_type", "Content-Encoding must be gzip or absent");
    }
    const length = Number(request.headers["content-length"]);
    if (Number.isFinite(length) && length > maxBody) {
      throw new IngestError("payload_too_large", `request body exceeds ${maxBody} bytes`);
    }
    request.ingest = { projectId: record.projectId, keyId: record.keyId, receivedAt, ...(limits && { limits }) };
  });

  app.post(INGEST_PATH, async (request, reply) => {
    if (!request.ingest) throw new Error("ingest route is missing its authentication preHandler");
    const { projectId, keyId, receivedAt, limits } = request.ingest;
    const parsed = request.body as { json: unknown; bytes: number } | undefined;
    if (parsed === undefined) throw new IngestError("invalid_json", "request body is empty");

    const result = validateIngestRequest(parsed.json, {
      now: receivedAt,
      bodyBytes: parsed.bytes,
      maxBodyBytes: maxBody,
    });
    if (!result.ok) {
      reply.status(result.status).send(result.response);
      return;
    }
    // Steps 2 and 3, exactly: charge every event in the request against the
    // project's day and minute in one atomic step, shared by all API processes.
    if (opts.limits && limits) {
      const events = result.accepted.length + result.duplicates.length + result.rejected.length;
      const charged = await opts.limits.charge(projectId, receivedAt, events, limits);
      setRateLimitHeaders(reply, limits, charged.minuteEvents, receivedAt);
      if (charged.outcome === "quota_exceeded") {
        // Dropped, not queued (docs/retention.md, "Quotas"), and counted.
        // Best effort, like the rejected counter below.
        try {
          await opts.metadata.incrementDailyCounters(projectId, {
            day: receivedAt.toISOString().slice(0, 10),
            dropped: events,
          });
        } catch (err) {
          request.log.warn(
            { err: { type: (err as Error).name, message: (err as Error).message }, project_id: projectId },
            "dropped counter update failed",
          );
        }
        throw quotaExceeded(limits, receivedAt);
      }
      if (charged.outcome === "rate_limited") throw rateLimited(limits, receivedAt);
    }
    if (result.accepted.length > 0) {
      const job: IngestJob = {
        project_id: projectId,
        key_id: keyId,
        received_at: receivedAt.toISOString(),
        events: result.accepted.map((a) => a.event),
      };
      // The protocol defines skew as received_at - sent_at; the helper
      // reports the client clock minus the server clock.
      if (result.skewMs !== undefined) job.skew_ms = -result.skewMs;
      // Step 7: one row, so either every accepted event is queued or none is.
      try {
        await opts.queue.enqueue(job);
      } catch (err) {
        if (err instanceof QueueFullError) {
          request.log.warn({ project_id: projectId, max_depth: err.maxDepth }, "ingest queue full");
          throw new IngestError("unavailable", "the ingest queue is full; retry later", QUEUE_FULL_RETRY_AFTER_SECONDS);
        }
        request.log.error(
          { err: { type: (err as Error).name, message: (err as Error).message }, project_id: projectId },
          "enqueue failed",
        );
        throw new IngestError("unavailable", "the server could not accept events; retry later", RETRY_AFTER_SECONDS);
      }
    }
    // Daily `rejected` counter (docs/retention.md, "What is retained"). One
    // statement, attempted once per request and never retried, so it applies
    // at most once. The events are already queued, so a failure here is
    // logged and the 202 stands: a retrying client would only add repeats.
    if (result.rejected.length > 0) {
      try {
        await opts.metadata.incrementDailyCounters(projectId, {
          day: receivedAt.toISOString().slice(0, 10),
          rejected: result.rejected.length,
        });
      } catch (err) {
        request.log.warn(
          { err: { type: (err as Error).name, message: (err as Error).message }, project_id: projectId },
          "rejected counter update failed",
        );
      }
    }
    request.log.info(
      {
        project_id: projectId,
        key_id: keyId,
        accepted: result.response.accepted.length,
        rejected: result.rejected.length,
      },
      "ingest accepted",
    );
    reply.status(202).send(result.response);
  });
}
