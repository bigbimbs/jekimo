// Steps are separate and idempotent, event store first, with no transaction
// spanning the event store and metadata (docs/architecture.md, "Storage
// engines", rules 2 and 3): append, then merge issue counts derived from the
// event store, then add the job's counts to the daily counters under the
// job's id. A retry after any failure converges on the same state, and a
// redelivered job is counted once.

import {
  deriveFingerprint,
  type EventEnvelope,
  effectiveRetentionDays,
  isExpired,
  normalizeRetentionDays,
  RETENTION,
  redactEvent,
  shouldKeepEvent,
  validateEvent,
} from "@jekimo/event-schema";
import {
  type AppendEvent,
  DAILY_COUNTER_RETENTION_MONTHS,
  daysFrom,
  type IngestJob,
  type IssueSummary,
} from "@jekimo/storage-postgres";
import { DAY_MS, PREPARE_PARTITION_DAYS } from "./constants/index.js";
import { issueTitle } from "./issue.js";
import { RedactorCache } from "./redact.js";
import type {
  DroppedEvent,
  ExpiryOptions,
  ExpiryResult,
  ProcessContext,
  ProcessDeps,
  ProcessResult,
  ProjectExpiry,
} from "./types/index.js";

export async function processIngestJob(job: IngestJob, deps: ProcessDeps, ctx: ProcessContext): Promise<ProcessResult> {
  const settings = await deps.metadata.getProjectSettings(job.project_id);
  if (!settings) {
    return { projectFound: false, received: job.events.length, sampledOut: 0, dropped: [], inserted: 0 };
  }
  const redact = await (ctx.redactors ?? new RedactorCache(deps.metadata)).get(job.project_id);

  const receivedAt = new Date(job.received_at);
  // The API checked future timestamps against the client's sent_at; check
  // against the same instant so an accepted event is not dropped here.
  const sentAt = new Date(receivedAt.getTime() - (job.skew_ms ?? 0));
  let sampledOut = 0;
  const dropped: DroppedEvent[] = [];
  const append: AppendEvent[] = [];
  job.events.forEach((e, index) => {
    // Sampled-out events were already acknowledged as accepted in the 202.
    if (!shouldKeepEvent(e, settings.sampleRate)) {
      sampledOut++;
      return;
    }
    // Fingerprinting assumes a well-formed event, so validate first. A derived
    // fingerprint is always a valid one.
    const result = validateEvent(
      { ...redactEvent(e, redact), project_id: job.project_id },
      { mode: "stored", now: sentAt },
    );
    if (!result.ok) {
      dropped.push({
        index,
        eventId: String(e.event_id),
        errors: result.errors.map(({ path, code }) => ({ path, code })),
      });
      return;
    }
    const event = { ...result.event, project_id: job.project_id };
    const stored: AppendEvent = {
      receivedAt,
      keyId: job.key_id,
      event: { ...event, fingerprint: deriveFingerprint(event) },
    };
    if (job.skew_ms !== undefined) stored.skewMs = job.skew_ms;
    append.push(stored);
  });

  const { inserted } = await deps.events.appendEvents(job.project_id, append);

  // Recompute every fingerprint in the job, not only the new rows, so a
  // retry after a failed issue update still repairs the summary. The latest
  // event prefers one this attempt inserted over a repeat of an older one.
  const insertedIds = new Set(inserted);
  const latest = new Map<string, EventEnvelope>();
  const environments = new Map<string, Set<string>>();
  for (const a of append) {
    const fp = a.event.fingerprint;
    const prev = latest.get(fp);
    if (!prev || insertedIds.has(a.event.event_id) || !insertedIds.has(prev.event_id)) latest.set(fp, a.event);
    if (a.event.environment !== undefined) {
      const envs = environments.get(fp) ?? new Set<string>();
      environments.set(fp, envs.add(a.event.environment));
    }
  }
  const derived = await deps.events.summarizeFingerprints(job.project_id, [...latest.keys()]);
  const summaries: IssueSummary[] = [];
  for (const d of derived) {
    const e = latest.get(d.fingerprint);
    if (!e) continue;
    summaries.push({
      ...d,
      title: issueTitle(e),
      kind: e.kind,
      lastSeverity: e.severity,
      environments: [...(environments.get(d.fingerprint) ?? [])],
      // This job's events are the newest only if nothing was received later.
      ...(d.lastSeen.getTime() === receivedAt.getTime() && { lastEventId: e.event_id }),
    });
  }
  await deps.metadata.upsertIssues(job.project_id, summaries);

  // Counts depend only on the job's content, so every attempt computes the
  // same numbers and the idempotency key lets exactly one of them apply.
  // Repeats of earlier events count as accepted, as in the 202 response.
  await deps.metadata.incrementDailyCounters(job.project_id, {
    day: receivedAt.toISOString().slice(0, 10),
    accepted: append.length,
    dropped: dropped.length,
    sampled: sampledOut,
    idempotencyKey: `job:${ctx.jobId}`,
  });

  return { projectFound: true, received: job.events.length, sampledOut, dropped, inserted: inserted.length };
}

/** The first UTC day still inside the 13-month counter retention. */
export function counterRetentionStart(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - DAILY_COUNTER_RETENTION_MONTHS;
  // Clamp to the target month's length, so 31 March maps to 28 or 29 February.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(now.getUTCDate(), lastDay))).toISOString().slice(0, 10);
}

/** docs/retention.md, "Project retention period". */
export function projectRetentionDays(
  stored: number,
  defaultDays: number = RETENTION.DEFAULT_DAYS,
  maxDays: number = RETENTION.MAX_DAYS,
): number {
  const days = normalizeRetentionDays(stored) ?? defaultDays;
  return Math.min(days, maxDays);
}

/**
 * One expiry pass (docs/retention.md, "Expiry mechanics"): drop each
 * project's days whose newest possible event has passed retention, oldest
 * day first, recount the issues of each project that lost events, prune the
 * deduplication index, drop daily counters older than 13 months and counter
 * idempotency keys older than the deduplication window, and create the next
 * week's partitions.
 */
export async function runExpiryPass(
  deps: ProcessDeps,
  now: Date,
  clock: () => Date = () => new Date(),
  options: ExpiryOptions = {},
): Promise<ExpiryResult> {
  const days = await deps.events.listDays();
  const level = options.emergency ? "critical" : "ok";
  const projects = (await deps.metadata.listProjectRetention()).map(({ projectId, retentionDays }) => ({
    projectId,
    retentionDays: effectiveRetentionDays(
      projectRetentionDays(retentionDays, options.retentionDefaultDays, options.retentionMaxDays),
      level,
    ),
  }));
  const deleted = new Map<string, number>();
  for (const day of days) {
    const endOfDay = new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS);
    for (const { projectId, retentionDays } of projects) {
      if (!isExpired(endOfDay, retentionDays, now)) continue;
      const n = (await deps.events.expireDay(projectId, day)).deleted;
      deleted.set(projectId, (deleted.get(projectId) ?? 0) + n);
    }
  }
  let deletedEvents = 0;
  const perProject: ProjectExpiry[] = [];
  for (const { projectId, retentionDays } of projects) {
    const n = deleted.get(projectId) ?? 0;
    if (n === 0 && !options.recountAll) continue;
    const asOf = clock();
    await deps.metadata.replaceIssueCounts(projectId, await deps.events.summarizeFingerprints(projectId), asOf);
    if (n > 0) {
      deletedEvents += n;
      perProject.push({ projectId, deleted: n, retentionDays });
    }
  }
  const dedupeCutoff = new Date(now.getTime() - RETENTION.DEDUPE_WINDOW_DAYS * DAY_MS);
  const dedupePruned = await deps.events.pruneDedupe(dedupeCutoff);
  const counters = await deps.metadata.pruneDailyCounters(counterRetentionStart(now), dedupeCutoff);
  // Audit entries are instance-wide and outlive the projects they mention.
  const auditPruned = await deps.metadata.pruneAudit(
    new Date(now.getTime() - (deps.auditLogDays ?? RETENTION.AUDIT_LOG_DAYS) * DAY_MS),
  );
  await deps.events.prepareDays(daysFrom(new Date(now.getTime() - DAY_MS), PREPARE_PARTITION_DAYS));
  return {
    deletedEvents,
    projectsTouched: perProject.length,
    dedupePruned,
    countersPruned: counters.counters,
    perProject,
    auditPruned,
  };
}
