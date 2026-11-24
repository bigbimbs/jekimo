import { randomUUID } from "node:crypto";
import { withTransaction } from "./pool.js";
import { scheduleQueryAlerts } from "./query-alerts.js";
import { insertAudit, requirePermission } from "./sql-shared.js";
import type { Actor, ProjectAccess } from "./types/access.js";
import type {
  AlertRule,
  ClaimedNotification,
  NotificationChannel,
  NotificationDelivery,
  NotificationPayload,
  NotificationRepository,
  QueryObservation,
} from "./types/notifications.js";
import type { Pool } from "./types/pool.js";

export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly pool: Pool) {}

  scheduleQueryAlerts(projectId: string, observations: QueryObservation[]) {
    return scheduleQueryAlerts(this.pool, projectId, observations);
  }

  async getSmtp(): Promise<string | null> {
    return (
      (await this.pool.query<{ encrypted: string }>("SELECT encrypted FROM notification_settings WHERE id")).rows[0]
        ?.encrypted ?? null
    );
  }

  async saveSmtp(actor: Actor, encrypted: string): Promise<void> {
    if (actor.instanceRole !== "admin") throw new Error("instance admin required");
    await withTransaction(this.pool, async (db) => {
      await db.query(
        "INSERT INTO notification_settings(encrypted) VALUES ($1) ON CONFLICT (id) DO UPDATE SET encrypted = $1",
        [encrypted],
      );
      await insertAudit(db, {
        actorUserId: actor.userId,
        action: "instance.settings_updated",
        targetType: "instance",
        details: { area: "email" },
      });
    });
  }

  async listChannels(access: ProjectAccess): Promise<NotificationChannel[]> {
    requirePermission(access, "settings.manage");
    return (
      await this.pool.query<NotificationChannel>(
        "SELECT id, name, kind, enabled FROM notification_channels WHERE project_id = $1 ORDER BY name",
        [access.projectId],
      )
    ).rows;
  }

  async saveChannel(access: ProjectAccess, channel: NotificationChannel, encrypted: string): Promise<void> {
    requirePermission(access, "settings.manage");
    await withTransaction(this.pool, async (db) => {
      await db.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [access.projectId]);
      const count = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM notification_channels WHERE project_id = $1",
        [access.projectId],
      );
      if (Number(count.rows[0]?.n) >= 50) throw new RangeError("channel limit reached");
      await db.query(
        "INSERT INTO notification_channels(id, project_id, name, kind, enabled, encrypted) VALUES ($1,$2,$3,$4,$5,$6)",
        [channel.id, access.projectId, channel.name, channel.kind, channel.enabled, encrypted],
      );
      await insertAudit(db, {
        actorUserId: access.userId,
        action: "project.settings_updated",
        projectId: access.projectId,
        targetType: "project",
        targetId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        details: { area: "notification_channel", name: channel.name, kind: channel.kind },
      });
    });
  }

  async setChannelEnabled(access: ProjectAccess, id: string, enabled: boolean): Promise<boolean> {
    requirePermission(access, "settings.manage");
    return withTransaction(this.pool, async (db) => {
      const result = await db.query("UPDATE notification_channels SET enabled = $3 WHERE project_id = $1 AND id = $2", [
        access.projectId,
        id,
        enabled,
      ]);
      if (!result.rowCount) return false;
      await insertAudit(db, {
        actorUserId: access.userId,
        action: "project.settings_updated",
        projectId: access.projectId,
        targetType: "project",
        targetId: access.projectId,
        details: { area: "notification_channel", channel_id: id, enabled },
      });
      return true;
    });
  }

  async listRules(access: ProjectAccess): Promise<AlertRule[]> {
    requirePermission(access, "settings.manage");
    return (
      await this.pool.query<
        AlertRule & { thresholdMs: number | null; environment: string | null; queryName: string | null }
      >(
        `SELECT id, name, channel_id AS "channelId", trigger, cooldown_minutes AS "cooldownMinutes", enabled, threshold_ms AS "thresholdMs", environment, query_name AS "queryName" FROM notification_rules WHERE project_id = $1 ORDER BY created_at DESC`,
        [access.projectId],
      )
    ).rows.map(({ thresholdMs, environment, queryName, ...rule }) => ({
      ...rule,
      ...(thresholdMs != null && { thresholdMs }),
      ...(environment != null && { environment }),
      ...(queryName != null && { queryName }),
    }));
  }

  async saveRule(access: ProjectAccess, rule: AlertRule): Promise<boolean> {
    requirePermission(access, "settings.manage");
    return withTransaction(this.pool, async (db) => {
      await db.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [access.projectId]);
      const count = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM notification_rules WHERE project_id = $1 AND id <> $2",
        [access.projectId, rule.id],
      );
      if (Number(count.rows[0]?.n) >= 50) throw new RangeError("rule limit reached");
      const result = await db.query(
        `INSERT INTO notification_rules(id, project_id, channel_id, name, trigger, cooldown_minutes, enabled, threshold_ms, environment, query_name)
        SELECT $2, $1, id, $4, $5, $6, $7, $8, $9, $10 FROM notification_channels WHERE project_id = $1 AND id = $3
        ON CONFLICT (id) DO UPDATE SET channel_id = EXCLUDED.channel_id, name = EXCLUDED.name, trigger = EXCLUDED.trigger,
          cooldown_minutes = EXCLUDED.cooldown_minutes, enabled = EXCLUDED.enabled,
          threshold_ms = EXCLUDED.threshold_ms, environment = EXCLUDED.environment, query_name = EXCLUDED.query_name, effective_at = now()
        WHERE notification_rules.project_id = $1`,
        [
          access.projectId,
          rule.id,
          rule.channelId,
          rule.name,
          rule.trigger,
          rule.cooldownMinutes,
          rule.enabled,
          rule.thresholdMs ?? null,
          rule.environment ?? null,
          rule.queryName ?? null,
        ],
      );
      if (!result.rowCount) return false;
      await insertAudit(db, {
        actorUserId: access.userId,
        action: "project.settings_updated",
        projectId: access.projectId,
        targetType: "project",
        targetId: access.projectId,
        details: {
          area: "alert_rule",
          name: rule.name,
          enabled: rule.enabled,
          trigger: rule.trigger,
          ...(rule.thresholdMs !== undefined && { threshold_ms: rule.thresholdMs }),
        },
      });
      return true;
    });
  }

  async listDeliveries(access: ProjectAccess | null): Promise<NotificationDelivery[]> {
    if (access) requirePermission(access, "settings.manage");
    return (
      await this.pool.query<NotificationDelivery>(
        `SELECT id, channel_name AS "channelName", status, attempts, created_at::text AS "createdAt", error
      FROM notification_deliveries WHERE project_id IS NOT DISTINCT FROM $1 ORDER BY created_at DESC LIMIT 100`,
        [access?.projectId ?? null],
      )
    ).rows;
  }

  async enqueueTest(access: ProjectAccess, channelId: string): Promise<boolean> {
    requirePermission(access, "settings.manage");
    return withTransaction(this.pool, async (db) => {
      await db.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [access.projectId]);
      const result = await db.query(
        `INSERT INTO notification_deliveries(project_id,channel_id,channel_name,kind,payload)
        SELECT project_id,id,name,kind,$3::jsonb FROM notification_channels c WHERE project_id = $1 AND id = $2 AND enabled
        AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.channel_id = c.id AND d.created_at > now() - interval '1 minute')`,
        [
          access.projectId,
          channelId,
          JSON.stringify({
            subject: "Jekimo test notification",
            text: "Your project notification channel is connected.",
          }),
        ],
      );
      return Boolean(result.rowCount);
    });
  }

  async enqueueEmail(actor: Actor, encrypted: string, payload: NotificationPayload): Promise<boolean> {
    if (actor.instanceRole !== "admin") throw new Error("instance admin required");
    return withTransaction(this.pool, async (db) => {
      await db.query("SELECT id FROM notification_settings WHERE id FOR UPDATE");
      const result = await db.query(
        `INSERT INTO notification_deliveries(channel_name,kind,encrypted,payload)
        SELECT 'Email test','email',$1,$2::jsonb WHERE NOT EXISTS
        (SELECT 1 FROM notification_deliveries WHERE project_id IS NULL AND created_at > now() - interval '1 minute')`,
        [encrypted, JSON.stringify(payload)],
      );
      return Boolean(result.rowCount);
    });
  }

  async scheduleAlerts(): Promise<number> {
    return withTransaction(this.pool, async (db) => {
      // One scheduler transaction at a time also serializes cooldown checks.
      const lock = await db.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(811472, 11) AS locked");
      if (!lock.rows[0]?.locked) return 0;
      const signals = await db.query<{
        id: string;
        project_id: string;
        issue_id: string;
        trigger: "new_issue" | "regression";
        title: string;
        created_at: Date;
      }>("SELECT * FROM notification_signals ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED");
      let queued = 0;
      for (const s of signals.rows) {
        const rules = await db.query<{
          id: string;
          channel_id: string;
          name: string;
          kind: string;
          cooldown_minutes: number;
        }>(
          `SELECT r.id,c.id AS channel_id,c.name,c.kind,r.cooldown_minutes
          FROM notification_rules r JOIN notification_channels c ON c.id = r.channel_id AND c.project_id = r.project_id
          WHERE r.project_id = $1 AND r.trigger = $2 AND r.enabled AND c.enabled AND r.created_at <= $3`,
          [s.project_id, s.trigger, s.created_at],
        );
        for (const r of rules.rows) {
          const allowed = await db.query(
            `INSERT INTO notification_cooldowns(rule_id,issue_id,last_sent_at) VALUES ($1,$2,now())
            ON CONFLICT (rule_id,issue_id) DO UPDATE SET last_sent_at = now()
            WHERE notification_cooldowns.last_sent_at <= now() - $3 * interval '1 minute' RETURNING rule_id`,
            [r.id, s.issue_id, r.cooldown_minutes],
          );
          if (!allowed.rowCount) continue;
          const subject = s.trigger === "new_issue" ? "New issue" : "Issue occurred again";
          await db.query(
            `INSERT INTO notification_deliveries(project_id,channel_id,channel_name,kind,payload,status,error)
            SELECT $1,$2,$3,$4,$5::jsonb,CASE WHEN count(*) < 1000 THEN 'queued' ELSE 'failed' END,
              CASE WHEN count(*) < 1000 THEN NULL ELSE 'queue_full' END FROM notification_deliveries
              WHERE project_id = $1 AND status IN ('queued','retrying','sending')`,
            [
              s.project_id,
              r.channel_id,
              r.name,
              r.kind,
              JSON.stringify({
                subject,
                text: s.title,
                issueId: s.issue_id,
                projectId: s.project_id,
                trigger: s.trigger,
              }),
            ],
          );
          queued++;
        }
        await db.query("DELETE FROM notification_signals WHERE id = $1", [s.id]);
      }
      return queued;
    });
  }

  async claim(): Promise<ClaimedNotification | null> {
    return withTransaction(this.pool, async (db) => {
      await db.query(`UPDATE notification_deliveries SET status = 'failed',error = 'attempts_exhausted',encrypted = NULL
        WHERE status IN ('queued','retrying','sending') AND available_at <= now() AND attempts >= 5`);
      const lease = randomUUID();
      const result = await db.query<{
        id: string;
        attempts: number;
        kind: ClaimedNotification["kind"];
        encrypted: string | null;
        channel_id: string | null;
        payload: NotificationPayload;
      }>(
        `UPDATE notification_deliveries SET status = 'sending', attempts = attempts + 1,
        lease = $1, available_at = now() + interval '2 minutes' WHERE id = (
        SELECT id FROM notification_deliveries WHERE status IN ('queued','retrying','sending') AND available_at <= now()
        ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, attempts, kind, encrypted, channel_id, payload`,
        [lease],
      );
      const row = result.rows[0];
      if (!row) return null;
      let secret = row.encrypted;
      if (row.channel_id) {
        secret =
          (
            await db.query<{ encrypted: string }>(
              "SELECT encrypted FROM notification_channels WHERE id = $1 AND enabled",
              [row.channel_id],
            )
          ).rows[0]?.encrypted ?? null;
      }
      if (!secret) {
        await db.query(
          "UPDATE notification_deliveries SET status = 'failed', error = 'channel_disabled' WHERE id = $1",
          [row.id],
        );
        return null;
      }
      // Bind encrypted settings to the channel, or the instance test context.
      return {
        id: row.id,
        lease,
        attempts: row.attempts,
        kind: row.kind,
        secret: `${row.channel_id ?? "email-test"}:${secret}`,
        payload: row.payload,
      };
    });
  }

  async finish(job: ClaimedNotification, error: string | null, permanent = false): Promise<void> {
    const status = !error ? "sent" : permanent || job.attempts >= 5 ? "failed" : "retrying";
    await this.pool.query(
      `UPDATE notification_deliveries SET status = $3,error = $4, available_at = now() + $5 * interval '1 second',
      encrypted = CASE WHEN $3 IN ('sent','failed') THEN NULL ELSE encrypted END
      WHERE id = $1 AND lease = $2 AND status = 'sending'`,
      [job.id, job.lease, status, error, Math.min(3600, 30 * 2 ** (job.attempts - 1))],
    );
  }

  async prune(): Promise<void> {
    await this.pool.query("DELETE FROM notification_query_receipts WHERE received_at < now() - interval '8 days'");
    await this.pool.query("DELETE FROM notification_deliveries WHERE created_at < now() - interval '30 days'");
    await this.pool.query(
      "UPDATE notification_deliveries SET status = 'failed', error = 'expired', encrypted = NULL WHERE status IN ('queued','retrying','sending') AND created_at < now() - interval '1 day'",
    );
    await this.pool.query("DELETE FROM notification_signals WHERE created_at < now() - interval '1 day'");
    await this.pool.query("DELETE FROM notification_cooldowns WHERE last_sent_at < now() - interval '2 days'");
  }
}
