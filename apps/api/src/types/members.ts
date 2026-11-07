import type { MetadataRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { MemberService } from "../modules/members/service.js";

export interface MemberServiceDeps {
  metadata: MetadataRepository;
}

export interface MemberRouteOptions {
  service: MemberService;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
}

export type MemberTarget = { userId: string } | { email: string };
