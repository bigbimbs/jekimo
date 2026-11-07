import type { MetadataRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { AccountService } from "../modules/account/service.js";
import type { PasswordHasher } from "./auth.js";

export interface AccountToken {
  /** Returned once; never stored or logged. */
  token: string;
  tokenHash: Uint8Array;
}

export interface AdminCommandDeps {
  metadata: MetadataRepository;
  inviteExpiryDays: number;
  publicUrl: string | null;
  clock: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface AccountServiceDeps {
  metadata: MetadataRepository;
  hasher: PasswordHasher;
  clock: () => Date;
}

export interface AccountRouteOptions {
  service: AccountService;
  session: preHandlerHookHandler;
}
