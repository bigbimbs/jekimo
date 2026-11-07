import type { EventEnvelope, EventKind, Severity } from "@jekimo/event-schema";

/** One event to append, already validated, stamped, and fingerprinted. */
export interface AppendEvent {
  receivedAt: Date;
  keyId: string;
  skewMs?: number;
  event: EventEnvelope & { project_id: string; fingerprint: string };
}

export interface StoredEvent {
  receivedAt: Date;
  keyId: string;
  skewMs?: number;
  event: EventEnvelope & { project_id: string; fingerprint: string };
}

export interface EventQuery {
  /** Inclusive lower bound on received_at. */
  from: Date;
  /** Exclusive upper bound on received_at. */
  to: Date;
  /** Any of these severities. */
  severities?: Severity[];
  /** Any of these kinds. */
  kinds?: EventKind[];
  /** Exact match. */
  environment?: string;
  /** Exact match. */
  release?: string;
  /** Exact match. */
  fingerprint?: string;
  /**
   * Events whose message contains every word of this text, case-insensitive.
   * Word matching only: no ranking, no stemming, no phrase or prefix syntax.
   * Only valid when `capabilities.textSearch` is true.
   */
  text?: string;
  limit: number;
  /** Opaque cursor from a previous page's nextCursor. */
  cursor?: string;
}

/**
 * Query features that are cheap on one engine and expensive on another
 * (docs/architecture.md, "Designed for ClickHouse from day one", rule 4).
 * Callers check these and degrade instead of assuming them.
 */
export interface EventStoreCapabilities {
  textSearch: boolean;
}

export interface EventPage {
  events: StoredEvent[];
  nextCursor?: string;
}

export interface FingerprintSummary {
  fingerprint: string;
  eventCount: number;
  firstSeen: Date;
  lastSeen: Date;
}

/**
 * Event rows live behind this boundary so another engine can implement it
 * (docs/architecture.md, "Storage engines"). Every operation is scoped to one
 * project; there is no cross-project read. Appends are idempotent on
 * (project_id, event_id).
 */
export interface EventStore {
  readonly capabilities: EventStoreCapabilities;
  /** Returns the event_ids that were new; repeats are ignored, not errors. */
  appendEvents(projectId: string, events: AppendEvent[]): Promise<{ inserted: string[] }>;
  /** Newest first by received_at. Throws RangeError for an invalid cursor or unsupported filter. */
  queryEvents(projectId: string, query: EventQuery): Promise<EventPage>;
  /** Another project's event_id is null, never its event. */
  getEvent(projectId: string, eventId: string): Promise<StoredEvent | null>;
  /** Derived counts per fingerprint, for issue summaries. All fingerprints when omitted. */
  summarizeFingerprints(projectId: string, fingerprints?: string[]): Promise<FingerprintSummary[]>;
  /**
   * Removes one project's events for one UTC day (YYYY-MM-DD). Idempotent and
   * safe to interrupt: queries see either the whole day or none of it.
   */
  expireDay(projectId: string, day: string): Promise<{ deleted: number }>;
  /** Phase 2 (docs/object-storage.md). Not implemented in the first release. */
  archiveDay(projectId: string, day: string): Promise<never>;
  /** UTC days that may hold events, oldest first. Used by the expiry pass. */
  listDays(): Promise<string[]>;
  /** Makes sure storage for these UTC days exists before events arrive. */
  prepareDays(days: string[]): Promise<void>;
  /** Forgets deduplication entries for events received before `before`. */
  pruneDedupe(before: Date): Promise<number>;
}
