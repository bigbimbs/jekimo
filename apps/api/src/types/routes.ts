import type { MetadataRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { PasswordHasher } from "../passwords.js";

export interface AccountRouteOptions {
  metadata: MetadataRepository;
  hasher: PasswordHasher;
  clock: () => Date;
  session: preHandlerHookHandler;
}

export interface UserRouteOptions {
  metadata: MetadataRepository;
  session: preHandlerHookHandler;
  inviteExpiryDays: number;
  publicUrl: string | null;
  clock: () => Date;
}

export interface MemberRouteOptions {
  metadata: MetadataRepository;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
  retentionMaxDays: number;
}

export interface KeyRouteOptions {
  metadata: MetadataRepository;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
  /** Default grace period for a rotated key. */
  rotationGraceHours: number;
  clock: () => Date;
}
