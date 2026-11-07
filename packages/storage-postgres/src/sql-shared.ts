import type { ProjectPermission } from "@jekimo/event-schema";
import { assertProjectAccess, type ProjectAccess } from "./access.js";
import type { Pool, PoolClient } from "./pool.js";
import type { UserRow } from "./types/index.js";
import type { AuditEntry, UserRecord } from "./types.js";

export const USER_COLUMNS = "u.id, u.email, u.instance_role, u.status, u.created_at";

export function toUser(r: UserRow): UserRecord {
  return { id: r.id, email: r.email, instanceRole: r.instance_role, status: r.status, createdAt: r.created_at };
}

export async function insertAudit(db: Pool | PoolClient, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, project_id, source_ip, via_instance_admin, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      entry.actorUserId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.projectId ?? null,
      entry.sourceIp ?? null,
      entry.viaInstanceAdmin ?? false,
      JSON.stringify(entry.details ?? {}),
    ],
  );
}

export function requirePermission(access: ProjectAccess, permission: ProjectPermission): void {
  assertProjectAccess(access);
  if (!access.permissions.has(permission)) throw new Error(`missing permission ${permission}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ids from requests are checked before they reach a uuid column, where a malformed one is a query error.
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
