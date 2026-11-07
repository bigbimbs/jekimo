/**
 * Storage boundaries. Two stores, one boundary (docs/architecture.md,
 * "Storage engines"): metadata always lives in PostgreSQL behind
 * MetadataRepository; event rows live behind EventStore so another engine can
 * implement it later. No caller outside this package writes SQL.
 */

import type { EventEnvelope, EventKind, ProjectPermission, Severity } from "@jekimo/event-schema";
import type { ProjectAccess } from "./access.js";

export type InstanceRole = "admin" | "member";

/** The signed-in person a metadata call acts for. */
export interface Actor {
  userId: string;
  instanceRole: InstanceRole;
}

export interface UserRecord {
  id: string;
  email: string;
  instanceRole: InstanceRole;
  status: "active" | "deactivated";
  createdAt: Date;
}

export interface SessionRecord {
  sessionId: string;
  user: UserRecord;
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface ProjectRecord {
  id: string;
  name: string;
  retentionDays: number;
  sampleRate: number;
  disabled: boolean;
  createdAt: Date;
}

export interface IngestionKeyRecord {
  keyId: string;
  projectId: string;
  name: string;
  createdAt: Date;
}

/** What the ingest endpoint needs to authenticate a bearer key. */
export interface IngestionKeyLookup {
  keyId: string;
  projectId: string;
  /** SHA-256 of the full key string. */
  keyHash: Uint8Array;
  revokedAt: Date | null;
  expiresAt: Date | null;
  projectDisabled: boolean;
}

export interface AuditEntry {
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  projectId?: string;
  sourceIp?: string;
  viaInstanceAdmin?: boolean;
  /** Never put passwords, keys, session tokens, or event payloads here. */
  details?: Record<string, unknown>;
}

export interface IssueSummary {
  fingerprint: string;
  title: string;
  kind: EventKind;
  lastSeverity: Severity;
  eventCount: number;
  firstSeen: Date;
  lastSeen: Date;
}

export interface IssueRecord extends IssueSummary {
  projectId: string;
  status: "unresolved" | "resolved" | "ignored";
}

export interface ProjectRetention {
  projectId: string;
  retentionDays: number;
}

export interface MetadataRepository {
  // Setup and authentication. These are instance-level, not project data.
  countUsers(): Promise<number>;
  /** Creates the first instance admin. Returns null when any user already exists. */
  createFirstAdmin(input: { email: string; passwordHash: string }): Promise<UserRecord | null>;
  findUserForLogin(email: string): Promise<{ user: UserRecord; passwordHash: string } | null>;
  countFailedLogins(userId: string, since: Date): Promise<number>;
  createSession(input: {
    userId: string;
    tokenHash: Uint8Array;
    csrfToken: string;
    expiresAt: Date;
    sourceIp?: string;
    userAgent?: string;
  }): Promise<void>;
  /** Returns a live session: not revoked, not past its absolute expiry, user active. */
  findSession(tokenHash: Uint8Array, now: Date): Promise<SessionRecord | null>;
  touchSession(sessionId: string, now: Date): Promise<void>;
  revokeSession(sessionId: string, now: Date): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;

  // Projects. Membership is enforced here: project data is only reachable
  // through a ProjectAccess, which only resolveProjectAccess can create.
  createProject(
    actor: Actor,
    input: { id: string; name: string; retentionDays: number; sourceIp?: string },
  ): Promise<ProjectRecord>;
  /** Projects the actor is a member of. Instance admins see every project. */
  listProjects(actor: Actor): Promise<ProjectRecord[]>;
  /** Null when the project does not exist or the actor cannot access it. */
  resolveProjectAccess(actor: Actor, projectId: string): Promise<ProjectAccess | null>;
  getProject(access: ProjectAccess): Promise<ProjectRecord>;
  createIngestionKey(
    access: ProjectAccess,
    input: { keyId: string; keyHash: Uint8Array; name: string; sourceIp?: string },
  ): Promise<IngestionKeyRecord>;

  // Ingest authentication: the project comes from the key, never the request.
  findIngestionKey(keyId: string): Promise<IngestionKeyLookup | null>;

  // Worker. projectId here was derived from an ingestion key by the API.
  getProjectSettings(projectId: string): Promise<{ retentionDays: number; sampleRate: number } | null>;
  /** Merges summaries into issues; counts and last_seen only move forward. */
  upsertIssues(projectId: string, summaries: IssueSummary[]): Promise<void>;
  /**
   * Sets exact counts for listed fingerprints and deletes issues not listed.
   * Only touches issues last updated before `asOf`, the time the summaries
   * were read, so a concurrent upsert is never undone.
   */
  replaceIssueCounts(projectId: string, summaries: FingerprintSummary[], asOf: Date): Promise<void>;

  // Maintenance: instance-wide listing used only by the expiry pass.
  listProjectRetention(): Promise<ProjectRetention[]>;

  // Daily counters (docs/retention.md, "What is retained"). projectId here
  // was derived from an ingestion key by the API, or from a queued job.
  /**
   * Adds to one project's counters for one UTC day. With an idempotency key,
   * a repeat of the same key for the project is ignored and returns false.
   */
  incrementDailyCounters(projectId: string, input: DailyCounterIncrement): Promise<boolean>;
  /** Counters for UTC days in [from, to], oldest first. Days with no counts are omitted. */
  listDailyCounters(access: ProjectAccess, range: { from: string; to: string }): Promise<DailyCounters[]>;
  /** Deletes counters for days before `beforeDay` and idempotency keys created before `keysBefore`. */
  pruneDailyCounters(beforeDay: string, keysBefore: Date): Promise<{ counters: number; keys: number }>;

  // Project redaction rules (docs/event-format.md, "Privacy defaults").
  /** For the worker. Null when the project does not exist. */
  getRedactionRules(projectId: string): Promise<RedactionRules | null>;
  /** Requires settings.manage. Rules are normalized and validated; returns what was stored. */
  setRedactionRules(access: ProjectAccess, rules: RedactionRules, sourceIp?: string): Promise<RedactionRules>;
}

/** One event to append, already validated, stamped, and fingerprinted. */
export interface AppendEvent {
  receivedAt: Date;
  keyId: string;
  skewMs?: number;
  /** Stored form: project_id and fingerprint set. */
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
  severities?: Severity[];
  limit: number;
  /** Opaque cursor from a previous page's nextCursor. */
  cursor?: string;
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
 * Event store boundary. Every operation is scoped to one project; there is no
 * cross-project read. Appends are idempotent on (project_id, event_id).
 */
export interface EventStore {
  /** Returns the event_ids that were new; repeats are ignored, not errors. */
  appendEvents(projectId: string, events: AppendEvent[]): Promise<{ inserted: string[] }>;
  /** Newest first by received_at. */
  queryEvents(projectId: string, query: EventQuery): Promise<EventPage>;
  /** Derived counts per fingerprint, for issue summaries. All fingerprints when omitted. */
  summarizeFingerprints(projectId: string, fingerprints?: string[]): Promise<FingerprintSummary[]>;
  /** Removes one project's events for one UTC day (YYYY-MM-DD). Idempotent. */
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

export interface Job<T> {
  id: string;
  /** Changes on every claim; ack and fail only apply to the current lease. */
  leaseId: string;
  payload: T;
  /** Including the current one. */
  attempts: number;
  maxAttempts: number;
}

/** Small durable queue. Delivery is at least once; consumers are idempotent. */
export interface Queue<T> {
  enqueue(payload: T): Promise<string>;
  /** Claims up to `limit` ready jobs until the visibility timeout passes. */
  dequeue(limit: number): Promise<Job<T>[]>;
  ack(job: Job<T>): Promise<void>;
  /** Schedules a retry with backoff, or dead-letters after maxAttempts. */
  fail(job: Job<T>, error: unknown): Promise<"retry" | "dead">;
  /** Depth, oldest-job age, and dead-lettered count, for health checks. */
  stats(): Promise<QueueStats>;
}

/** Queue that carries accepted events from the ingest endpoint to the worker. */
export const INGEST_QUEUE = "ingest";

/** One ingest request's accepted events, as enqueued by the API. */
export interface IngestJob {
  /** Derived from the ingestion key, never from the request. */
  project_id: string;
  key_id: string;
  /** Server time the request was received, RFC 3339. */
  received_at: string;
  /** received_at minus the client's sent_at, when sent_at was usable. */
  skew_ms?: number;
  /** Validated envelopes in ingest form, unique by event_id. */
  events: EventEnvelope[];
}

export type { ProjectPermission };

export type DailyCounterName = "accepted" | "rejected" | "dropped" | "sampled";

/** One project's counts for one UTC day. */
export interface DailyCounters {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  accepted: number;
  rejected: number;
  dropped: number;
  sampled: number;
}

export interface DailyCounterIncrement extends Partial<Record<DailyCounterName, number>> {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Makes the increment apply at most once per project, for example `job:<id>`. */
  idempotencyKey?: string;
}

/** Operator-configured redaction on top of DEFAULT_REDACTED_KEYS. */
export interface RedactionRules {
  /** Key names, stored normalized (lower-cased, without `-`, `_`, and spaces). */
  keys: string[];
  /** Regular expression sources matched against key names. */
  patterns: string[];
}

export interface QueueStats {
  /** Jobs waiting, including those scheduled for a retry. */
  pending: number;
  /** Jobs claimed by a worker. */
  running: number;
  /** pending + running: what counts toward the size bound. */
  depth: number;
  /** Dead-lettered jobs kept for inspection. */
  dead: number;
  /** Age of the oldest pending or running job, or null when there is none. */
  oldestAgeMs: number | null;
}
