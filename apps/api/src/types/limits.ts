import type { IngestLimitSettings, IngestLimitStore, IngestLimits } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { LimitService } from "../modules/limits/service.js";

export interface LimitServiceDeps {
  limits: IngestLimitStore;
  defaults: IngestLimits;
}

export interface LimitRouteOptions {
  service: LimitService;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
}

export interface ResolvedLimits {
  settings: IngestLimitSettings;
  effective: IngestLimits;
}
