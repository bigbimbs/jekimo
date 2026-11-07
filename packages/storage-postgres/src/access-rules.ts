import { AUDIT_ACTIONS, type AuditAction, type IngestionKeyStatus } from "./constants/index.js";
import type { IngestionKeySummary } from "./types/index.js";

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export function ingestionKeyStatus(key: IngestionKeySummary, now: Date): IngestionKeyStatus {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt === null) return "active";
  return key.expiresAt > now ? "rotating" : "expired";
}
