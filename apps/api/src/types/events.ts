import type { EventStore } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { EventService } from "../modules/events/service.js";

export interface EventServiceDeps {
  events: EventStore;
  clock: () => Date;
}

export interface EventRouteOptions {
  service: EventService;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
}
