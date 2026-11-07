/**
 * The only queries that read across projects (docs/access-model.md,
 * "Authorization enforcement", rule 1): the project listing for a member or
 * an instance admin, ingestion key lookup (the key decides the project), and
 * the instance-wide retention listing used by the expiry pass. Everything
 * else in this package takes a project id or a ProjectAccess.
 */

import type { Pool, PoolClient } from "./pool.js";
import type { Actor, IngestionKeyLookup, ProjectRecord, ProjectRetention } from "./types.js";

export interface ProjectRow {
  id: string;
  name: string;
  retention_days: number;
  sample_rate: number;
  disabled: boolean;
  created_at: Date;
}

export const PROJECT_COLUMNS = "p.id, p.name, p.retention_days, p.sample_rate, p.disabled, p.created_at";

export function toProject(r: ProjectRow): ProjectRecord {
  return {
    id: r.id,
    name: r.name,
    retentionDays: r.retention_days,
    sampleRate: r.sample_rate,
    disabled: r.disabled,
    createdAt: r.created_at,
  };
}

/** Projects the actor is a member of. Instance admins see every project. */
export async function listProjectsForActor(db: Pool | PoolClient, actor: Actor): Promise<ProjectRecord[]> {
  const { rows } =
    actor.instanceRole === "admin"
      ? await db.query<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM projects p ORDER BY p.created_at, p.id`)
      : await db.query<ProjectRow>(
          `SELECT ${PROJECT_COLUMNS} FROM projects p JOIN project_members m ON m.project_id = p.id
           WHERE m.user_id = $1 ORDER BY p.created_at, p.id`,
          [actor.userId],
        );
  return rows.map(toProject);
}

/** Ingest authentication: the project comes from the key, never the request. */
export async function findIngestionKey(db: Pool | PoolClient, keyId: string): Promise<IngestionKeyLookup | null> {
  const { rows } = await db.query<{
    key_id: string;
    project_id: string;
    key_hash: Buffer;
    revoked_at: Date | null;
    expires_at: Date | null;
    disabled: boolean;
  }>(
    `SELECT k.key_id, k.project_id, k.key_hash, k.revoked_at, k.expires_at, p.disabled
     FROM ingestion_keys k JOIN projects p ON p.id = k.project_id WHERE k.key_id = $1`,
    [keyId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    keyId: r.key_id,
    projectId: r.project_id,
    keyHash: new Uint8Array(r.key_hash),
    revokedAt: r.revoked_at,
    expiresAt: r.expires_at,
    projectDisabled: r.disabled,
  };
}

/** Every project's retention period, for the expiry pass. */
export async function listProjectRetention(db: Pool | PoolClient): Promise<ProjectRetention[]> {
  const { rows } = await db.query<{ id: string; retention_days: number }>(
    "SELECT id, retention_days FROM projects ORDER BY id",
  );
  return rows.map((r) => ({ projectId: r.id, retentionDays: r.retention_days }));
}
