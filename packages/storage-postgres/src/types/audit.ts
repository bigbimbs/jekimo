import type { AuditAction } from "../constants/audit.js";

export interface AuditEntry {
  actorUserId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  projectId?: string;
  sourceIp?: string;
  viaInstanceAdmin?: boolean;
  /** Never put passwords, keys, session tokens, or event payloads here. */
  details?: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  occurredAt: Date;
  actorUserId: string | null;
  /** The actor's current email, or null when the user was deleted. */
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  projectId: string | null;
  sourceIp: string | null;
  viaInstanceAdmin: boolean;
  details: Record<string, unknown>;
}

export interface AuditQuery {
  actorUserId?: string;
  action?: string;
  /** Inclusive lower bound on occurred_at. */
  from?: Date;
  /** Exclusive upper bound on occurred_at. */
  to?: Date;
  /** Entries with an id below this one: the previous page's last id. */
  beforeId?: string;
  limit: number;
}
