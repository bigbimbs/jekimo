import type { CronRepository, DiskMonitor, MetadataRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { CronService } from "../modules/cron/service.js";
export interface CronServiceDeps {
  repository: CronRepository;
  metadata: MetadataRepository;
  clock: () => Date;
  disk?: DiskMonitor;
}
export interface CronRouteOptions {
  service: CronService;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
}
