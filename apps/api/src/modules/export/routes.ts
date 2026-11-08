import type { FastifyInstance } from "fastify";
import {
  EXPORT_COMPRESSIONS,
  type ExportCompression,
  GZIP_CONTENT_TYPE,
  NDJSON_CONTENT_TYPE,
} from "../../constants/index.js";
import { ApiError } from "../../errors.js";
import { parseTime } from "../../request.js";
import { projectAccessOf } from "../../session.js";
import type { ExportRouteOptions } from "../../types/index.js";

function parseCompression(value: unknown): ExportCompression {
  if (value === undefined) return "none";
  if (typeof value === "string" && (EXPORT_COMPRESSIONS as readonly string[]).includes(value)) {
    return value as ExportCompression;
  }
  throw new ApiError(400, "invalid_request", `compression must be one of ${EXPORT_COMPRESSIONS.join(", ")}`);
}

export async function exportRoutes(app: FastifyInstance, opts: ExportRouteOptions): Promise<void> {
  const { service } = opts;

  app.get(
    "/api/v1/projects/:id/export",
    { preHandler: [opts.session, opts.projectAccess], config: { permission: "data.export" } },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const from = parseTime(q.from, "from");
      const to = parseTime(q.to, "to");
      const compression = parseCompression(q.compression);
      const access = projectAccessOf(request);
      const body = await service.start(access, {
        ...(from && { from }),
        ...(to && { to }),
        compression,
        sourceIp: request.ip,
      });
      const gzip = compression === "gzip";
      const safeId = access.projectId.replace(/[^A-Za-z0-9_-]/g, "_");
      const filename = `jekimo-${safeId}.ndjson${gzip ? ".gz" : ""}`;
      return reply
        .header("content-type", gzip ? GZIP_CONTENT_TYPE : NDJSON_CONTENT_TYPE)
        .header("content-disposition", `attachment; filename="${filename}"`)
        .header("cache-control", "no-store")
        .send(body);
    },
  );
}
