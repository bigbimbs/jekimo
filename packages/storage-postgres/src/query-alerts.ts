import { withTransaction } from "./pool.js";
import type { AlertRule, QueryObservation } from "./types/notifications.js";
import type { Pool } from "./types/pool.js";

export async function scheduleQueryAlerts(
  pool: Pool,
  projectId: string,
  observations: QueryObservation[],
): Promise<number> {
  if (!observations.length) return 0;
  return withTransaction(pool, async (db) => {
    // Match saveRule's project lock to serialize changes, receipts, and cooldowns.
    const project = await db.query("SELECT id FROM projects WHERE id=$1 AND NOT disabled FOR UPDATE", [projectId]);
    if (!project.rowCount) return 0;
    const rules = await db.query<AlertRule & { effectiveAt: Date; channelName: string; kind: string }>(
      `
      SELECT r.id,r.name,r.channel_id AS "channelId",r.cooldown_minutes AS "cooldownMinutes",r.threshold_ms AS "thresholdMs",
        r.environment,r.query_name AS "queryName",r.effective_at AS "effectiveAt",c.name AS "channelName",c.kind
      FROM notification_rules r JOIN notification_channels c ON c.id=r.channel_id AND c.project_id=r.project_id
      WHERE r.project_id=$1 AND r.trigger='slow_query' AND r.enabled AND c.enabled`,
      [projectId],
    );
    let queued = 0;
    for (const observation of observations) {
      const receipt = await db.query(
        `INSERT INTO notification_query_receipts(project_id,event_id,received_at)
        SELECT $1,$2,$3::timestamptz WHERE $3::timestamptz >= now()-interval '1 day' AND $3::timestamptz <= now()
        ON CONFLICT DO NOTHING RETURNING event_id`,
        [projectId, observation.eventId, observation.receivedAt],
      );
      if (!receipt.rowCount) continue;
      for (const rule of rules.rows) {
        if (
          observation.receivedAt < rule.effectiveAt ||
          observation.database.duration_ms < (rule.thresholdMs ?? Infinity) ||
          (rule.environment != null && rule.environment !== observation.environment) ||
          (rule.queryName != null && rule.queryName !== observation.database.name)
        )
          continue;
        const allowed = await db.query(
          `UPDATE notification_rules SET last_query_alert_at=now() WHERE id=$1
          AND (last_query_alert_at IS NULL OR last_query_alert_at <= now()-cooldown_minutes*interval '1 minute') RETURNING id`,
          [rule.id],
        );
        if (!allowed.rowCount) continue;
        await db.query(
          `INSERT INTO notification_deliveries(project_id,channel_id,channel_name,kind,payload,status,error)
          SELECT $1,$2,$3,$4,$5::jsonb,CASE WHEN count(*)<1000 THEN 'queued' ELSE 'failed' END,
          CASE WHEN count(*)<1000 THEN NULL ELSE 'queue_full' END FROM notification_deliveries
          WHERE project_id=$1 AND status IN ('queued','retrying','sending')`,
          [
            projectId,
            rule.channelId,
            rule.channelName,
            rule.kind,
            JSON.stringify({
              subject: "Slow database query",
              text: `${observation.database.name} took ${Math.round(observation.database.duration_ms * 100) / 100} ms (threshold: ${rule.thresholdMs} ms).`,
              projectId,
              eventId: observation.eventId,
              trigger: "slow_query",
            }),
          ],
        );
        queued++;
      }
    }
    return queued;
  });
}
