/**
 * A project's ingestion rate limit and daily quota (docs/ingestion-protocol.md,
 * "Rate limits and quotas"; docs/retention.md, "Quotas"). Anyone who can read
 * the project can see them; only instance admins can change them.
 */

import {
  INGEST_LIMIT_BOUNDS,
  type IngestLimitSettings,
  type IngestLimitStore,
  type IngestLimits,
} from "@jekimo/storage-postgres";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { ApiError } from "../errors.js";
import { actorOf, projectAccessOf } from "../session.js";

export interface LimitRouteOptions {
  limits: IngestLimitStore;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
  /** Instance-wide defaults, for the effective values. */
  defaults: IngestLimits;
}

function publicLimits(settings: IngestLimitSettings, defaults: IngestLimits) {
  return {
    // null: the project inherits the instance-wide default.
    settings: { rate_limit_per_minute: settings.rateLimitPerMinute, events_per_day: settings.eventsPerDay },
    effective: {
      rate_limit_per_minute: settings.rateLimitPerMinute ?? defaults.ratePerMinute,
      events_per_day: settings.eventsPerDay ?? defaults.eventsPerDay,
    },
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
  const projectRoute = { preHandler: [opts.session, opts.projectAccess] };

  app.get(
    "/api/v1/projects/:id/limits",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => ({
      limits: publicLimits(await opts.limits.getSettings(projectAccessOf(request)), opts.defaults),
    }),
  );

  app.put(
    "/api/v1/projects/:id/limits",
    { ...projectRoute, config: { permission: "project.read" } },
    async (request) => {
      const actor = actorOf(request);
      if (actor.instanceRole !== "admin") {
        throw new ApiError(403, "forbidden", "only instance admins can change ingestion limits");
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const { MIN_PER_MINUTE, MAX_PER_MINUTE, MIN_PER_DAY, MAX_PER_DAY } = INGEST_LIMIT_BOUNDS;
      const stored = await opts.limits.setSettings(
        actor,
        projectAccessOf(request),
        {
          rateLimitPerMinute: setting(body, "rate_limit_per_minute", MIN_PER_MINUTE, MAX_PER_MINUTE),
          eventsPerDay: setting(body, "events_per_day", MIN_PER_DAY, MAX_PER_DAY),
        },
        request.ip,
      );
      request.log.info({ project_id: projectAccessOf(request).projectId }, "ingest limits updated");
      return { limits: publicLimits(stored, opts.defaults) };
    },
  );
}
