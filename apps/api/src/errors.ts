import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/** An error with a status and a stable code, rendered as `{ error: { code, message } }`. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const GENERIC: Record<number, [string, string]> = {
  400: ["invalid_request", "the request is not valid"],
  401: ["unauthorized", "authentication required"],
  403: ["forbidden", "not allowed"],
  404: ["not_found", "not found"],
  413: ["payload_too_large", "request body is too large"],
  415: ["unsupported_media_type", "unsupported content type"],
};

/**
 * Error handler for the dashboard-facing API. Never echoes request bodies:
 * JSON syntax errors carry a snippet of the body in their message, so 4xx
 * errors from the framework get a generic message.
 */
export function apiErrorHandler(err: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ApiError) {
    if (err.retryAfter !== undefined) reply.header("retry-after", String(err.retryAfter));
    reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    return;
  }
  const status =
    typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  if (status >= 500) {
    request.log.error({ err: { type: err.name, code: err.code, message: err.message } }, "request failed");
    reply.status(500).send({ error: { code: "internal", message: "internal error" } });
    return;
  }
  const isJson =
    err instanceof SyntaxError ||
    err.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    err.code === "FST_ERR_CTP_EMPTY_JSON_BODY";
  const [code, message] = isJson
    ? ["invalid_json", "request body is not valid JSON"]
    : (GENERIC[status] ?? ["invalid_request", "the request is not valid"]);
  request.log.info({ status, code: err.code }, "request rejected");
  reply.status(status).send({ error: { code, message } });
}
