import type { MetadataRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { TwoFactorService } from "../modules/two-factor/service.js";
import type { PasswordHasher } from "./auth.js";

export interface TwoFactorServiceDeps {
  metadata: MetadataRepository;
  hasher: PasswordHasher;
  encryptionKey: string | null;
  clock(): Date;
}

export interface TwoFactorRouteOptions {
  service: TwoFactorService;
  session: preHandlerHookHandler;
}
