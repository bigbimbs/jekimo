import type { IngestLimitStore, IngestLimits } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";

export interface LimitRouteOptions {
  limits: IngestLimitStore;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
  defaults: IngestLimits;
}
