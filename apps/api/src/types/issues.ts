import type { EventStore, MetadataRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";

export interface IssueRouteOptions {
  metadata: MetadataRepository;
  events: EventStore;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
}
