import type { MetadataRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { KeyService } from "../modules/keys/service.js";

export interface GeneratedKey {
  keyId: string;
  /** The full key. Returned to the user once and never stored or logged. */
  key: string;
  keyHash: Uint8Array;
}

export interface KeyRecordForCheck {
  keyHash: Uint8Array;
}

export interface KeyServiceDeps {
  metadata: MetadataRepository;
  clock: () => Date;
}

export interface KeyRouteOptions {
  service: KeyService;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
  /** Default grace period for a rotated key. */
  rotationGraceHours: number;
}
