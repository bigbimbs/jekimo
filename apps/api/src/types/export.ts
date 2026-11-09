import type { EventStore, MetadataRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { ExportCompression } from "../constants/export.js";
import type { ExportService } from "../modules/export/service.js";

export interface ExportServiceDeps {
  metadata: MetadataRepository;
  events: EventStore;
  clock: () => Date;
}

export interface ExportRequest {
  /** Unset exports from the project's first event. */
  from?: Date;
  /** Exclusive; unset means the time of the request. */
  to?: Date;
  compression: ExportCompression;
  sourceIp: string;
}

export interface ExportRouteOptions {
  service: ExportService;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
}
