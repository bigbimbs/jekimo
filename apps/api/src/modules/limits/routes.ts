// Only instance admins change a project's limits (docs/retention.md, "Quotas").

import { INGEST_LIMIT_BOUNDS } from "@jekimo/storage-postgres";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../../errors.js";
import { bodyOf } from "../../request.js";
import { actorOf, projectAccessOf } from "../../session.js";
import type { LimitRouteOptions, ResolvedLimits } from "../../types/index.js";

function publicLimits({ settings, effective }: ResolvedLimits) {
  return {
    settings: { rate_limit_per_minute: settings.rateLimitPerMinute, events_per_day: settings.eventsPerDay },
    effective: { rate_limit_per_minute: effective.ratePerMinute, events_per_day: effective.eventsPerDay },
  };
}

function setting(body: Record<string, unknown>, name: string, min: number, max: number): number | null {
  const value = body[name];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError(400, "invalid_request", `${name} must be null or a whole number from ${min} to ${max}`);
  }
  return value;
}

export async function limitRoutes(app: FastifyInstance, opts: LimitRouteOptions): Promise<void> {
  const { service } = opts;
  const projectRoute = { preHandler: [opts.session, opts.projectAccess] };

  app.get(
    "/api/v1/projects/:id/limits",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => ({ limits: publicLimits(await service.get(projectAccessOf(request))) }),
  );

  app.put(
    "/api/v1/projects/:id/limits",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => {
      const actor = actorOf(request);
      if (actor.instanceRole !== "admin") {
        throw new ApiError(403, "forbidden", "only instance admins can change ingestion limits");
      }
      const body = bodyOf(request);
      const { MIN_PER_MINUTE, MAX_PER_MINUTE, MIN_PER_DAY, MAX_PER_DAY } = INGEST_LIMIT_BOUNDS;
      const access = projectAccessOf(request);
      const limits = await service.set(
        actor,
        access,
        {
          rateLimitPerMinute: setting(body, "rate_limit_per_minute", MIN_PER_MINUTE, MAX_PER_MINUTE),
          eventsPerDay: setting(body, "events_per_day", MIN_PER_DAY, MAX_PER_DAY),
        },
        request.ip,
      );
      request.log.info({ project_id: access.projectId }, "ingest limits updated");
      return { limits: publicLimits(limits) };
    },
  );
}
