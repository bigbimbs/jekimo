// POST /api/v1/ingest (docs/ingestion-protocol.md). Registered as its own
// encapsulated plugin with its own body parser and error handler and no
// session middleware: a session cookie cannot reach it and the bearer
// ingestion key is the only credential it accepts.

import { INGEST_ERROR_STATUS, INGEST_PATH, LIMITS, validateIngestRequest } from "@jekimo/event-schema";
import { type IngestLimits, secondsUntilNextMinute } from "@jekimo/storage-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { JSON_CONTENT_TYPE, RETRY_AFTER_SECONDS } from "../../constants/index.js";
import { IngestError } from "../../errors.js";
import type { IngestRouteOptions, ParsedIngestBody } from "../../types/index.js";
import { parseIngestBody } from "./body.js";
import { quotaExceeded, rateLimited } from "./service.js";

/** docs/ingestion-protocol.md, "Headers on every response". */
function setRateLimitHeaders(reply: FastifyReply, limits: IngestLimits, minuteEvents: number, now: Date): void {
  reply.header("x-ratelimit-limit", String(limits.ratePerMinute));
  reply.header("x-ratelimit-remaining", String(Math.max(0, limits.ratePerMinute - minuteEvents)));
  reply.header("x-ratelimit-reset", String(secondsUntilNextMinute(now)));
}

export async function ingestRoutes(app: FastifyInstance, opts: IngestRouteOptions): Promise<void> {
  const { service } = opts;
  const maxBody = opts.maxBodyBytes ?? LIMITS.MAX_BATCH_BYTES;

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

  // Limits apply before reading, and errors use the protocol's codes.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (request: FastifyRequest, payload, done) => {
    // Callback style on purpose: Fastify would also call done for a returned promise.
    void parseIngestBody(payload, request.headers["content-encoding"], maxBody).then(
      (parsed) => done(null, parsed),
      (err: Error) => done(err),
    );
  });

  app.addHook("onRequest", async (request, reply) => {
    const { record, receivedAt, limits, usage } = await service.authenticate(request.headers.authorization);
    // A 401 carries no X-RateLimit-* headers: no project is known.
    if (limits && usage) setRateLimitHeaders(reply, limits, usage.minuteEvents, receivedAt);
    await service.admit(record, receivedAt, limits, usage);
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
    const parsed = request.body as ParsedIngestBody | undefined;
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
    if (limits) {
      const events = result.accepted.length + result.duplicates.length + result.rejected.length;
      const charged = await service.charge(projectId, receivedAt, events, limits, request.log);
      if (charged) {
        setRateLimitHeaders(reply, limits, charged.minuteEvents, receivedAt);
        if (charged.outcome === "quota_exceeded") throw quotaExceeded(limits, receivedAt);
        if (charged.outcome === "rate_limited") throw rateLimited(limits, receivedAt);
      }
    }
    await service.enqueue(projectId, keyId, receivedAt, result, request.log);
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
