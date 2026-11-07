/**
 * Turns one queued ingest job into stored events, issue summaries, and daily
 * counts.
 *
 * Steps are separate and idempotent, event store first (docs/architecture.md,
 * "Storage engines", rules 2 and 3): sample, redact, validate in stored form,
 * fingerprint, append, derive issue counts from the event store and merge
 * them into metadata, then add the job's counts to the project's daily
 * counters under the job's id. A retry after any failure converges on the
 * same state, and a redelivered job is counted once.
 */

import {
  type EventEnvelope,
  type IssueCode,
  isExpired,
  RETENTION,
  shouldKeepEvent,
  validateEvent,
} from "@jekimo/event-schema";
import {
  type AppendEvent,
  DAILY_COUNTER_RETENTION_MONTHS,
  daysFrom,
  type EventStore,
  type IngestJob,
  type IssueSummary,
  type MetadataRepository,
} from "@jekimo/storage-postgres";
import { fingerprintOf, issueTitle } from "./fingerprint.js";
import { RedactorCache, redactEvent } from "./redact.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProcessDeps {
  metadata: MetadataRepository;
  events: EventStore;
}

export interface ProcessContext {
  /** Queue job id; the counters step uses `job:<id>` as its idempotency key. */
  jobId: string;
  /** Shared by the jobs of one batch. A fresh cache is used when omitted. */
  redactors?: RedactorCache;
}

/** An event that failed stored-form validation. Carries no event content. */
export interface DroppedEvent {
  index: number;
  eventId: string;
  errors: { path: string; code: IssueCode }[];
}

export interface ProcessResult {
  /** False when the project no longer exists; the job is dropped. */
  projectFound: boolean;
  received: number;
  sampledOut: number;
  /** Events that failed stored-form validation and were not stored. */
  dropped: DroppedEvent[];
  inserted: number;
}

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
    // Validate before fingerprinting, which assumes a well-formed event. A
    // derived fingerprint is always a valid one.
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
    // The validator returns the canonical envelope without unknown fields.
    const event = { ...result.event, project_id: job.project_id };
    const stored: AppendEvent = {
      receivedAt,
      keyId: job.key_id,
      event: { ...event, fingerprint: fingerprintOf(event) },
    };
    if (job.skew_ms !== undefined) stored.skewMs = job.skew_ms;
    append.push(stored);
  });

  const { inserted } = await deps.events.appendEvents(job.project_id, append);

  // Recompute every fingerprint in the job, not only the new rows, so a
  // retry after a failed issue update still repairs the summary.
  const latest = new Map<string, EventEnvelope>();
  for (const a of append) latest.set(a.event.fingerprint, a.event);
  const derived = await deps.events.summarizeFingerprints(job.project_id, [...latest.keys()]);
  const summaries: IssueSummary[] = [];
  for (const d of derived) {
    const e = latest.get(d.fingerprint);
    if (!e) continue; // only fingerprints from this job were requested
    summaries.push({ ...d, title: issueTitle(e), kind: e.kind, lastSeverity: e.severity });
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

export interface ExpiryResult {
  deletedEvents: number;
  projectsTouched: number;
  dedupePruned: number;
  countersPruned: number;
}

/**
 * One expiry pass (docs/retention.md, "Expiry mechanics"): drop each
 * project's days whose newest possible event has passed retention, recount
 * that project's issues from the event store, prune the deduplication index,
 * drop daily counters older than 13 months with counter idempotency keys
 * older than the deduplication window, and create the next week's partitions.
 */
export async function runExpiryPass(
  deps: ProcessDeps,
  now: Date,
  clock: () => Date = () => new Date(),
): Promise<ExpiryResult> {
  const days = await deps.events.listDays();
  const projects = await deps.metadata.listProjectRetention();
  let deletedEvents = 0;
  let projectsTouched = 0;
  for (const { projectId, retentionDays } of projects) {
    let deleted = 0;
    for (const day of days) {
      // The last instant of the day is the newest event it can hold.
      const endOfDay = new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS);
      if (!isExpired(endOfDay, retentionDays, now)) continue;
      deleted += (await deps.events.expireDay(projectId, day)).deleted;
    }
    if (deleted > 0) {
      const asOf = clock();
      await deps.metadata.replaceIssueCounts(projectId, await deps.events.summarizeFingerprints(projectId), asOf);
      deletedEvents += deleted;
      projectsTouched++;
    }
  }
  const dedupeCutoff = new Date(now.getTime() - RETENTION.DEDUPE_WINDOW_DAYS * DAY_MS);
  const dedupePruned = await deps.events.pruneDedupe(dedupeCutoff);
  const counters = await deps.metadata.pruneDailyCounters(counterRetentionStart(now), dedupeCutoff);
  await deps.events.prepareDays(daysFrom(new Date(now.getTime() - DAY_MS), 9));
  return { deletedEvents, projectsTouched, dedupePruned, countersPruned: counters.counters };
}
