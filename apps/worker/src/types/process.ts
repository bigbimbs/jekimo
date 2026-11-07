import type { IssueCode } from "@jekimo/event-schema";
import type { EventStore, MetadataRepository } from "@jekimo/storage-postgres";
import type { RedactorCache } from "../redact.js";

export interface ProcessDeps {
  metadata: MetadataRepository;
  events: EventStore;
  /** Audit log retention (JEKIMO_AUDIT_LOG_DAYS). Defaults to RETENTION.AUDIT_LOG_DAYS. */
  auditLogDays?: number;
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
