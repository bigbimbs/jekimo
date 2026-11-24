import { randomUUID } from "node:crypto";
import { CRON_LIMITS } from "./constants/cron.js";
import { nextCronDate } from "./cron-schedule.js";
import { withTransaction } from "./pool.js";
import { firstRow } from "./rows.js";
import { insertAudit, requirePermission } from "./sql-shared.js";
import type { ProjectAccess } from "./types/access.js";
import type { CronCheckIn, CronMonitor, CronMonitorInput, CronRepository, CronRun } from "./types/cron.js";
import type { Pool, PoolClient } from "./types/pool.js";

const MONITOR_COLUMNS = `id,name,expression,timezone,grace_seconds AS "graceSeconds",max_runtime_seconds AS "maxRuntimeSeconds",
 failure_threshold AS "failureThreshold",recovery_threshold AS "recoveryThreshold",channel_id AS "channelId",enabled,health,
 next_expected_at AS "nextExpectedAt",last_success_at AS "lastSuccessAt",consecutive_failures AS "consecutiveFailures",
 consecutive_successes AS "consecutiveSuccesses",incident_open AS "incidentOpen"`;
const RUN_COLUMNS = `id,status,started_at AS "startedAt",finished_at AS "finishedAt",expected_at AS "expectedAt",deadline_at AS "deadlineAt"`;

async function outcome(
  db: PoolClient,
  projectId: string,
  m: CronMonitor,
  ok: boolean,
  now: Date,
  reason = "The job reported a failure.",
): Promise<void> {
  const wasOpen = m.incidentOpen;
  if (ok) {
    m.consecutiveFailures = 0;
    m.consecutiveSuccesses++;
    m.lastSuccessAt = now;
    if (m.consecutiveSuccesses >= m.recoveryThreshold) {
      m.health = "healthy";
      m.incidentOpen = false;
    }
  } else {
    m.consecutiveSuccesses = 0;
    m.consecutiveFailures++;
    if (m.consecutiveFailures >= m.failureThreshold) {
      m.health = "failing";
      m.incidentOpen = true;
    }
  }
  await db.query(
    `UPDATE cron_monitors SET health=$2,incident_open=$3,consecutive_failures=$4,consecutive_successes=$5,last_success_at=$6 WHERE id=$1`,
    [m.id, m.health, m.incidentOpen, m.consecutiveFailures, m.consecutiveSuccesses, m.lastSuccessAt],
  );
  if (wasOpen === m.incidentOpen || !m.channelId) return;
  const subject = m.incidentOpen ? "Cron monitor needs attention" : "Cron monitor recovered";
  await db.query(
    `INSERT INTO notification_deliveries(project_id,channel_id,channel_name,kind,payload,status,error)
 SELECT c.project_id,c.id,c.name,c.kind,$3::jsonb,
 CASE WHEN (SELECT count(*) FROM notification_deliveries WHERE project_id=$1 AND status IN ('queued','retrying','sending'))<1000 THEN 'queued' ELSE 'failed' END,
 CASE WHEN (SELECT count(*) FROM notification_deliveries WHERE project_id=$1 AND status IN ('queued','retrying','sending'))<1000 THEN NULL ELSE 'queue_full' END
 FROM notification_channels c WHERE c.project_id=$1 AND c.id=$2 AND c.enabled`,
    [
      projectId,
      m.channelId,
      JSON.stringify({
        subject,
        text: `${m.name}\n${m.incidentOpen ? reason : "The job is completing successfully again."}`,
        projectId,
        monitorId: m.id,
      }),
    ],
  );
}

async function reconcile(db: PoolClient, projectId: string, m: CronMonitor, now: Date): Promise<void> {
  const expired = await db.query(
    `UPDATE cron_runs SET status='timeout',finished_at=deadline_at WHERE monitor_id=$1 AND status='started' AND deadline_at<$2 RETURNING id`,
    [m.id, now],
  );
  for (const _ of expired.rows) await outcome(db, projectId, m, false, now, "Maximum runtime exceeded.");
  if (m.nextExpectedAt.getTime() + m.graceSeconds * 1000 < now.getTime()) {
    await db.query(
      `INSERT INTO cron_runs(monitor_id,id,status,expected_at,finished_at,created_at) VALUES ($1,$2,'missed',$3,$4,$4)`,
      [m.id, randomUUID(), m.nextExpectedAt, now],
    );
    await outcome(db, projectId, m, false, now, "The scheduled start was missed.");
    // Collapse an outage gap to one missed-run record, retaining the first missed slot.
    m.nextExpectedAt = nextCronDate(m.expression, m.timezone, new Date(now.getTime() - m.graceSeconds * 1000));
    await db.query("UPDATE cron_monitors SET next_expected_at=$2 WHERE id=$1", [m.id, m.nextExpectedAt]);
  }
}

export class PostgresCronRepository implements CronRepository {
  constructor(private readonly pool: Pool) {}
  async list(access: ProjectAccess): Promise<CronMonitor[]> {
    requirePermission(access, "project.read");
    return (
      await this.pool.query<CronMonitor>(
        `SELECT ${MONITOR_COLUMNS} FROM cron_monitors WHERE project_id=$1 ORDER BY name`,
        [access.projectId],
      )
    ).rows;
  }
  async create(access: ProjectAccess, input: CronMonitorInput, now: Date): Promise<CronMonitor | null> {
    requirePermission(access, "settings.manage");
    const next = nextCronDate(input.expression, input.timezone, now);
    return withTransaction(this.pool, async (db) => {
      await db.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [access.projectId]);
      if (
        input.channelId &&
        !(
          await db.query("SELECT id FROM notification_channels WHERE project_id=$1 AND id=$2", [
            access.projectId,
            input.channelId,
          ])
        ).rowCount
      )
        return null;
      const count = await db.query<{ n: string }>("SELECT count(*) AS n FROM cron_monitors WHERE project_id=$1", [
        access.projectId,
      ]);
      if (Number(count.rows[0]?.n) >= CRON_LIMITS.monitors) throw new RangeError("monitor limit reached");
      const result = await db.query<CronMonitor>(
        `INSERT INTO cron_monitors(project_id,name,expression,timezone,grace_seconds,max_runtime_seconds,failure_threshold,recovery_threshold,channel_id,next_expected_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${MONITOR_COLUMNS}`,
        [
          access.projectId,
          input.name,
          input.expression,
          input.timezone,
          input.graceSeconds,
          input.maxRuntimeSeconds,
          input.failureThreshold,
          input.recoveryThreshold,
          input.channelId,
          next,
        ],
      );
      await insertAudit(db, {
        actorUserId: access.userId,
        action: "project.settings_updated",
        projectId: access.projectId,
        targetType: "project",
        targetId: access.projectId,
        details: { area: "cron_monitor", name: input.name },
      });
      return firstRow(result.rows, "create cron monitor");
    });
  }
  async setEnabled(access: ProjectAccess, id: string, enabled: boolean, now: Date): Promise<boolean> {
    requirePermission(access, "settings.manage");
    return withTransaction(this.pool, async (db) => {
      const m = (
        await db.query<CronMonitor>(
          `SELECT ${MONITOR_COLUMNS} FROM cron_monitors WHERE project_id=$1 AND id=$2 FOR UPDATE`,
          [access.projectId, id],
        )
      ).rows[0];
      if (!m) return false;
      if (m.enabled === enabled) return true;
      await db.query(
        `UPDATE cron_monitors SET enabled=$2,next_expected_at=$3,health='pending',incident_open=false,consecutive_failures=0,consecutive_successes=0 WHERE id=$1`,
        [id, enabled, nextCronDate(m.expression, m.timezone, now)],
      );
      // Pausing abandons in-flight runs without converting maintenance into a failure.
      await db.query(
        "UPDATE cron_runs SET status='cancelled',finished_at=$2 WHERE monitor_id=$1 AND status='started'",
        [id, now],
      );
      await insertAudit(db, {
        actorUserId: access.userId,
        action: "project.settings_updated",
        projectId: access.projectId,
        targetType: "project",
        targetId: access.projectId,
        details: { area: "cron_monitor", monitor_id: id, enabled },
      });
      return true;
    });
  }
  async runs(access: ProjectAccess, id: string): Promise<CronRun[] | null> {
    requirePermission(access, "project.read");
    if (
      !(await this.pool.query("SELECT id FROM cron_monitors WHERE project_id=$1 AND id=$2", [access.projectId, id]))
        .rowCount
    )
      return null;
    return (
      await this.pool.query<CronRun>(
        `SELECT ${RUN_COLUMNS} FROM cron_runs WHERE monitor_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,
        [id],
      )
    ).rows;
  }
  async checkIn(projectId: string, id: string, input: CronCheckIn, now: Date) {
    return withTransaction(this.pool, async (db) => {
      const m = (
        await db.query<CronMonitor>(
          `SELECT ${MONITOR_COLUMNS} FROM cron_monitors WHERE project_id=$1 AND id=$2 FOR UPDATE`,
          [projectId, id],
        )
      ).rows[0];
      if (!m) return "not_found" as const;
      if (!m.enabled) return "disabled" as const;
      const rate = await db.query(
        `UPDATE cron_monitors SET minute_start=date_trunc('minute',$2::timestamptz),minute_count=CASE WHEN minute_start=date_trunc('minute',$2::timestamptz) THEN minute_count+1 ELSE 1 END
    WHERE id=$1 AND (minute_start IS DISTINCT FROM date_trunc('minute',$2::timestamptz) OR minute_count<$3) RETURNING id`,
        [id, now, CRON_LIMITS.checkInsPerMinute],
      );
      if (!rate.rowCount) return "rate_limited" as const;
      await reconcile(db, projectId, m, now);
      const existing = (
        await db.query<CronRun>(`SELECT ${RUN_COLUMNS} FROM cron_runs WHERE monitor_id=$1 AND id=$2`, [id, input.runId])
      ).rows[0];
      if (existing && existing.status !== "started")
        return input.status === "started" ||
          input.status === existing.status ||
          existing.status === "timeout" ||
          existing.status === "cancelled"
          ? existing
          : ("conflict" as const);
      if (existing && input.status === "started") return existing;
      let expectedAt: Date | null = existing?.expectedAt ?? null;
      if (!existing) {
        const count = await db.query<{ n: string }>(
          "SELECT count(*) AS n FROM cron_runs WHERE monitor_id=$1 AND status='started'",
          [id],
        );
        if (Number(count.rows[0]?.n) >= CRON_LIMITS.concurrentRuns) return "rate_limited" as const;
        if (now >= m.nextExpectedAt) {
          expectedAt = m.nextExpectedAt;
          m.nextExpectedAt = nextCronDate(m.expression, m.timezone, now);
          await db.query("UPDATE cron_monitors SET next_expected_at=$2 WHERE id=$1", [id, m.nextExpectedAt]);
        }
        await db.query(
          `INSERT INTO cron_runs(monitor_id,id,status,started_at,finished_at,expected_at,deadline_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            input.runId,
            input.status,
            input.status === "started" ? now : null,
            input.status === "started" ? null : now,
            expectedAt,
            input.status === "started" ? new Date(now.getTime() + m.maxRuntimeSeconds * 1000) : null,
            now,
          ],
        );
      } else
        await db.query("UPDATE cron_runs SET status=$3,finished_at=$4 WHERE monitor_id=$1 AND id=$2", [
          id,
          input.runId,
          input.status,
          now,
        ]);
      if (input.status !== "started") await outcome(db, projectId, m, input.status === "ok", now);
      return firstRow(
        (
          await db.query<CronRun>(`SELECT ${RUN_COLUMNS} FROM cron_runs WHERE monitor_id=$1 AND id=$2`, [
            id,
            input.runId,
          ])
        ).rows,
        "read cron run",
      );
    });
  }
  async scan(now: Date): Promise<number> {
    return withTransaction(this.pool, async (db) => {
      const due = await db.query<CronMonitor & { projectId: string }>(
        `SELECT ${MONITOR_COLUMNS},project_id AS "projectId" FROM cron_monitors m WHERE enabled AND
    (next_expected_at+grace_seconds*interval '1 second'<$1 OR EXISTS(SELECT 1 FROM cron_runs r WHERE r.monitor_id=m.id AND r.status='started' AND r.deadline_at<$1))
    ORDER BY next_expected_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
        [now],
      );
      for (const m of due.rows) await reconcile(db, m.projectId, m, now);
      return due.rows.length;
    });
  }
  async prune(now: Date): Promise<void> {
    await this.pool.query("DELETE FROM cron_runs WHERE status<>'started' AND created_at<$1", [
      new Date(now.getTime() - CRON_LIMITS.historyDays * 86400000),
    ]);
  }
}
