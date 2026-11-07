import type { EventStore, MetadataRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { IssueService } from "../modules/issues/service.js";

export interface IssueServiceDeps {
  metadata: MetadataRepository;
  events: EventStore;
}

export interface IssueRouteOptions {
  service: IssueService;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
}
