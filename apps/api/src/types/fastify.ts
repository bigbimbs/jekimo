import type { ProjectPermission } from "@jekimo/event-schema";
import type { Actor, ProjectAccess, SessionRecord } from "@jekimo/storage-postgres";
import type { IngestContext } from "./ingest.js";

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
    session?: SessionRecord;
    projectAccess?: ProjectAccess;
    ingest?: IngestContext;
  }
  interface FastifyContextConfig {
    /** The project permission a /projects/:id route requires. */
    permission?: ProjectPermission;
  }
}
