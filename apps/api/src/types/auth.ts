import type { MetadataRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { AuthService, SetupGate } from "../modules/auth/service.js";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface SessionOptions {
  metadata: MetadataRepository;
  idleDays: number;
  clock: () => Date;
}

export interface AuthServiceDeps {
  metadata: MetadataRepository;
  hasher: PasswordHasher;
  setup: SetupGate;
  sessionMaxDays: number;
  /** Retention of the project created during setup. */
  retentionDefaultDays: number;
  clock: () => Date;
}

export interface AuthRouteOptions {
  service: AuthService;
  session: preHandlerHookHandler;
  sessionMaxDays: number;
}

export interface SetupInput {
  email: string;
  password: string;
  projectName: string;
  sourceIp: string;
}

export interface LoginInput {
  email: string;
  password: string;
  sourceIp: string;
  userAgent: string | undefined;
}
