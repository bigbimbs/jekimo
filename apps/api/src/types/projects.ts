import type { MetadataRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { ProjectService } from "../modules/projects/service.js";

export interface ProjectServiceDeps {
  metadata: MetadataRepository;
  membersCanCreateProjects: boolean;
  retentionDefaultDays: number;
  retentionMaxDays: number;
}

export interface ProjectRouteOptions {
  service: ProjectService;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
}

export interface NewProjectInput {
  name: string;
  /** The request's raw value; absent means the instance default. */
  retentionDays: unknown;
  sourceIp: string;
}
