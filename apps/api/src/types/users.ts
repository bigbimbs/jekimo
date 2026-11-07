import type { AuditQuery, InstanceRole, MetadataRepository, UserRecord } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { UserService } from "../modules/users/service.js";

export interface UserServiceDeps {
  metadata: MetadataRepository;
  inviteExpiryDays: number;
  publicUrl: string | null;
  clock: () => Date;
}

export interface UserRouteOptions {
  service: UserService;
  session: preHandlerHookHandler;
}

export interface UserChange {
  instanceRole?: InstanceRole;
  status?: UserRecord["status"];
}

export type AuditFilter = Omit<AuditQuery, "limit">;
