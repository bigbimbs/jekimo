import type { AccountTokenPurpose } from "../constants/access.js";
import type { IngestionKeyLookup, InstanceRole, UserRecord } from "./access.js";

export interface MemoryUser extends UserRecord {
  passwordHash: string;
}

export interface MemorySession {
  id: string;
  userId: string;
  tokenHash: Uint8Array;
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface MemoryAccountToken {
  id: string;
  purpose: AccountTokenPurpose;
  tokenHash: Uint8Array;
  email: string | null;
  instanceRole: InstanceRole | null;
  userId: string | null;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export type MemoryKey = IngestionKeyLookup & { name: string; createdAt: Date; createdBy?: string | null };
