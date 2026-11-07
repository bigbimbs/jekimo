/**
 * The only queries that read across projects (docs/access-model.md,
 * "Authorization enforcement", rule 1): the project listing for a member or
 * an instance admin, ingestion key lookup (the key decides the project), and
 * the instance-wide retention listing used by the expiry pass. Everything
 * else in this package takes a project id or a ProjectAccess.
 */

import { PROJECT_COLUMNS } from "./constants/sql.js";
import type { Actor, IngestionKeyLookup } from "./types/access.js";
import type { Pool, PoolClient } from "./types/pool.js";
import type { ProjectRecord, ProjectRetention } from "./types/projects.js";
import type { ProjectRow } from "./types/rows.js";

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

export async function listProjectRetention(db: Pool | PoolClient): Promise<ProjectRetention[]> {
  const { rows } = await db.query<{ id: string; retention_days: number }>(
    "SELECT id, retention_days FROM projects ORDER BY id",
  );
  return rows.map((r) => ({ projectId: r.id, retentionDays: r.retention_days }));
}
