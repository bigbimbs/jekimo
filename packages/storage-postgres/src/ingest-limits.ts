/**
 * Per-project ingestion rate limits and daily quotas (docs/ingestion-protocol.md,
 * "Rate limits and quotas"; docs/retention.md, "Quotas"). Usage is one row per
 * project, updated under a row lock, so the limits hold across API processes
 * and survive restarts.
 */

import { assertProjectAccess } from "./access.js";
import { INGEST_LIMIT_BOUNDS, type IngestChargeOutcome } from "./constants/ingest-limits.js";
import { withTransaction } from "./pool.js";
import { insertAudit } from "./sql-shared.js";
import type { Actor, ProjectAccess } from "./types/access.js";
import type {
  IngestChargeResult,
  IngestLimitSettings,
  IngestLimitStore,
  IngestLimits,
  IngestUsage,
  IngestUsageRow,
} from "./types/ingest-limits.js";
import type { Pool } from "./types/pool.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function minuteStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
}

/** Whole seconds, at least 1. */
export function secondsUntilNextMinute(now: Date): number {
  return Math.max(1, Math.ceil((minuteStart(now).getTime() + MINUTE_MS - now.getTime()) / 1000));
}

/** Whole seconds, at least 1. */
export function secondsUntilNextUtcDay(now: Date): number {
  const midnight = Math.floor(now.getTime() / DAY_MS) * DAY_MS + DAY_MS;
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

/** Counts from an earlier minute or day are zero. */
export function currentUsage(row: IngestUsageRow | null, now: Date): IngestUsage {
  if (!row) return { minuteEvents: 0, dayEvents: 0 };
  return {
    minuteEvents: row.minuteStart.getTime() === minuteStart(now).getTime() ? row.minuteEvents : 0,
    dayEvents: row.day === now.toISOString().slice(0, 10) ? row.dayEvents : 0,
  };
}

/**
 * Quota first (processing step 2), then the rate limit (step 3). A request is
 * admitted only when all its events fit, so a window admits exactly the
 * limit. Events refused for quota still count toward the minute, so a project
 * over quota stays bounded by its rate limit.
 */
export function decideCharge(
  row: IngestUsageRow | null,
  now: Date,
  events: number,
  limits: IngestLimits,
): { outcome: IngestChargeOutcome; next: IngestUsageRow } {
  if (!Number.isSafeInteger(events) || events < 0) throw new RangeError("events must be a non-negative integer");
  const usage = currentUsage(row, now);
  const window = (minuteEvents: number, dayEvents: number): IngestUsageRow => ({
    minuteStart: minuteStart(now),
    minuteEvents,
    day: now.toISOString().slice(0, 10),
    dayEvents,
  });
  if (limits.eventsPerDay !== null && usage.dayEvents + events > limits.eventsPerDay) {
    return { outcome: "quota_exceeded", next: window(usage.minuteEvents + events, usage.dayEvents) };
  }
  if (usage.minuteEvents + events > limits.ratePerMinute) {
    return { outcome: "rate_limited", next: window(usage.minuteEvents, usage.dayEvents) };
  }
  return { outcome: "admitted", next: window(usage.minuteEvents + events, usage.dayEvents + events) };
}

/** Throws RangeError unless each setting is null or within INGEST_LIMIT_BOUNDS. */
export function checkIngestLimitSettings(settings: IngestLimitSettings): IngestLimitSettings {
  const { MIN_PER_MINUTE, MAX_PER_MINUTE, MIN_PER_DAY, MAX_PER_DAY } = INGEST_LIMIT_BOUNDS;
  const check = (value: unknown, min: number, max: number, name: string): number | null => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`${name} must be null or an integer from ${min} to ${max}`);
    }
    return value;
  };
  return {
    rateLimitPerMinute: check(settings.rateLimitPerMinute, MIN_PER_MINUTE, MAX_PER_MINUTE, "rate_limit_per_minute"),
    eventsPerDay: check(settings.eventsPerDay, MIN_PER_DAY, MAX_PER_DAY, "events_per_day"),
  };
}

export function requireInstanceAdmin(actor: Actor, access: ProjectAccess): void {
  assertProjectAccess(access);
  if (actor.instanceRole !== "admin" || actor.userId !== access.userId) {
    throw new Error("only instance admins can change ingestion limits");
  }
}

interface SettingsRow {
  rate_limit_per_minute: number | null;
  events_per_day: string | null;
}

function toSettings(r: SettingsRow): IngestLimitSettings {
  return {
    rateLimitPerMinute: r.rate_limit_per_minute,
    eventsPerDay: r.events_per_day === null ? null : Number(r.events_per_day),
  };
}

interface UsageRow {
  minute_start: Date;
  minute_events: string;
  day: string;
  day_events: string;
}

function toUsageRow(r: UsageRow): IngestUsageRow {
  return {
    minuteStart: r.minute_start,
    minuteEvents: Number(r.minute_events),
    day: r.day,
    dayEvents: Number(r.day_events),
  };
}

export class PostgresIngestLimitStore implements IngestLimitStore {
  constructor(private readonly pool: Pool) {}

  async read(projectId: string, now: Date): Promise<(IngestLimitSettings & IngestUsage) | null> {
    const { rows } = await this.pool.query<SettingsRow & { [K in keyof UsageRow]: UsageRow[K] | null }>(
      `SELECT p.rate_limit_per_minute, p.events_per_day,
         u.minute_start, u.minute_events, to_char(u.day, 'YYYY-MM-DD') AS day, u.day_events
       FROM projects p LEFT JOIN project_ingest_usage u ON u.project_id = p.id
       WHERE p.id = $1`,
      [projectId],
    );
    const r = rows[0];
    if (!r) return null;
    const usage = r.minute_start === null ? null : toUsageRow(r as UsageRow);
    return { ...toSettings(r), ...currentUsage(usage, now) };
  }

  charge(projectId: string, now: Date, events: number, limits: IngestLimits): Promise<IngestChargeResult> {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO project_ingest_usage (project_id, minute_start, day) VALUES ($1, $2, $3::date)
         ON CONFLICT (project_id) DO NOTHING`,
        [projectId, minuteStart(now).toISOString(), now.toISOString().slice(0, 10)],
      );
      // The row lock serializes concurrent requests for the project from every API process.
      const { rows } = await client.query<UsageRow>(
        `SELECT minute_start, minute_events, to_char(day, 'YYYY-MM-DD') AS day, day_events
         FROM project_ingest_usage WHERE project_id = $1 FOR UPDATE`,
        [projectId],
      );
      const row = rows[0];
      const { outcome, next } = decideCharge(row ? toUsageRow(row) : null, now, events, limits);
      await client.query(
        `UPDATE project_ingest_usage SET minute_start = $2, minute_events = $3, day = $4::date, day_events = $5
         WHERE project_id = $1`,
        [projectId, next.minuteStart.toISOString(), next.minuteEvents, next.day, next.dayEvents],
      );
      return { outcome, minuteEvents: next.minuteEvents, dayEvents: next.dayEvents };
    });
  }

  async getSettings(access: ProjectAccess): Promise<IngestLimitSettings> {
    assertProjectAccess(access);
    const { rows } = await this.pool.query<SettingsRow>(
      "SELECT rate_limit_per_minute, events_per_day FROM projects WHERE id = $1",
      [access.projectId],
    );
    const r = rows[0];
    if (!r) throw new Error("project no longer exists");
    return toSettings(r);
  }

  async setSettings(
    actor: Actor,
    access: ProjectAccess,
    settings: IngestLimitSettings,
    sourceIp?: string,
  ): Promise<IngestLimitSettings> {
    requireInstanceAdmin(actor, access);
    const checked = checkIngestLimitSettings(settings);
    return await withTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query(
        "UPDATE projects SET rate_limit_per_minute = $2, events_per_day = $3, updated_at = now() WHERE id = $1",
        [access.projectId, checked.rateLimitPerMinute, checked.eventsPerDay],
      );
      if (rowCount !== 1) throw new Error("project no longer exists");
      await insertAudit(client, {
        actorUserId: actor.userId,
        action: "project.ingest_limits_updated",
        targetType: "project",
        targetId: access.projectId,
        projectId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        details: { rate_limit_per_minute: checked.rateLimitPerMinute, events_per_day: checked.eventsPerDay },
        ...(sourceIp !== undefined && { sourceIp }),
      });
      return checked;
    });
  }
}
