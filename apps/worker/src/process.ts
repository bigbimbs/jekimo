/**
 * Turns one queued ingest job into stored events and issue summaries.
 *
 * Steps are separate and idempotent, event store first (docs/architecture.md,
 * "Storage engines", rule 3): sample, redact, fingerprint, append, then
 * derive issue counts from the event store and merge them into metadata.
 * A retry after any failure converges on the same state.
 */

import { RETENTION, isExpired, shouldKeepEvent, type EventEnvelope } from "@jekimo/event-schema";
import { daysFrom, type AppendEvent, type EventStore, type IngestJob, type IssueSummary, type MetadataRepository } from "@jekimo/storage-postgres";
import { fingerprintOf, issueTitle } from "./fingerprint.js";
import { redactEvent } from "./redact.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProcessDeps {
  metadata: MetadataRepository;
  events: EventStore;
}

export interface ProcessResult {
  /** False when the project no longer exists; the job is dropped. */
  projectFound: boolean;
  received: number;
  sampledOut: number;
  inserted: number;
}

export async function processIngestJob(job: IngestJob, deps: ProcessDeps): Promise<ProcessResult> {
  const settings = await deps.metadata.getProjectSettings(job.project_id);
  if (!settings) return { projectFound: false, received: job.events.length, sampledOut: 0, inserted: 0 };

  const receivedAt = new Date(job.received_at);
  // Sampled-out events were already acknowledged as accepted in the 202.
  const kept = job.events.filter((e) => shouldKeepEvent(e, settings.sampleRate));
  const append: AppendEvent[] = kept.map((e) => {
    const event = { ...redactEvent(e), project_id: job.project_id };
    const stored: AppendEvent = { receivedAt, keyId: job.key_id, event: { ...event, fingerprint: fingerprintOf(event) } };
    if (job.skew_ms !== undefined) stored.skewMs = job.skew_ms;
    return stored;
  });

  const { inserted } = await deps.events.appendEvents(job.project_id, append);

  // Recompute every fingerprint in the job, not only the new rows, so a
  // retry after a failed issue update still repairs the summary.
  const latest = new Map<string, EventEnvelope>();
  for (const a of append) latest.set(a.event.fingerprint, a.event);
  const derived = await deps.events.summarizeFingerprints(job.project_id, [...latest.keys()]);
  const summaries: IssueSummary[] = derived.map((d) => {
    const e = latest.get(d.fingerprint)!;
    return { ...d, title: issueTitle(e), kind: e.kind, lastSeverity: e.severity };
  });
  await deps.metadata.upsertIssues(job.project_id, summaries);

  return { projectFound: true, received: job.events.length, sampledOut: job.events.length - kept.length, inserted: inserted.length };
}

export interface ExpiryResult {
  deletedEvents: number;
  projectsTouched: number;
  dedupePruned: number;
}

/**
 * One expiry pass (docs/retention.md, "Expiry mechanics"): drop each
 * project's days whose newest possible event has passed retention, recount
 * that project's issues from the event store, prune the deduplication index,
 * and create the next week's partitions.
 */
export async function runExpiryPass(deps: ProcessDeps, now: Date, clock: () => Date = () => new Date()): Promise<ExpiryResult> {
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
  const dedupePruned = await deps.events.pruneDedupe(new Date(now.getTime() - RETENTION.DEDUPE_WINDOW_DAYS * DAY_MS));
  await deps.events.prepareDays(daysFrom(new Date(now.getTime() - DAY_MS), 9));
  return { deletedEvents, projectsTouched, dedupePruned };
}
