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
import { type IngestJob, type MetadataRepository, type Queue, QueueFullError } from "@jekimo/storage-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { keyIdForLookup, verifyIngestionKey } from "../keys.js";

const gunzipAsync = promisify(gunzip);
const JSON_CONTENT_TYPE = /^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i;
const RETRY_AFTER_SECONDS = 5;
/** A full queue drains at the worker's pace, so clients wait longer. */
const QUEUE_FULL_RETRY_AFTER_SECONDS = 30;

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
    ingest?: { projectId: string; keyId: string; receivedAt: Date };
  }
}

export interface IngestRouteOptions {
  metadata: MetadataRepository;
  queue: Queue<IngestJob>;
  clock: () => Date;
  maxBodyBytes?: number;
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
  app.addHook("onRequest", async (request) => {
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
    if (record.projectDisabled) throw new IngestError("project_disabled", "project is disabled");
    // TODO(rate limits): per-project rate limits and quotas, 429 with
    // Retry-After and X-RateLimit-* headers, docs/ingestion-protocol.md
    // "Rate limits and quotas" and processing steps 2 and 3.
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
    request.ingest = { projectId: record.projectId, keyId: record.keyId, receivedAt };
  });

  app.post(INGEST_PATH, async (request, reply) => {
    if (!request.ingest) throw new Error("ingest route is missing its authentication preHandler");
    const { projectId, keyId, receivedAt } = request.ingest;
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
