import type { IssueStatus } from "../constants/issues.js";
import type {
  AccessRepository,
  Actor,
  IngestionKeyLookup,
  IngestionKeyRecord,
  ProjectAccess,
  SessionRecord,
  UserRecord,
} from "./access.js";
import type { AuditEntry } from "./audit.js";
import type { FingerprintSummary } from "./event-store.js";
import type { IssuePage, IssueQuery, IssueRecord, IssueSummary } from "./issues.js";
import type {
  DailyCounterIncrement,
  DailyCounters,
  ProjectRecord,
  ProjectRetention,
  RedactionRules,
} from "./projects.js";

/**
 * Metadata always lives in PostgreSQL behind this boundary, separate from
 * EventStore; no transaction spans the two, and no caller outside this
 * package writes SQL (docs/architecture.md, "Storage engines").
 */
export interface MetadataRepository extends AccessRepository {
  // Setup and authentication: instance-level, not project data.
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

  // Issues (docs/access-model.md, "Permission catalogue").
  /** Requires project.read. Newest last_seen first. Throws RangeError for an invalid cursor. */
  listIssues(access: ProjectAccess, query: IssueQuery): Promise<IssuePage>;
  /** Requires project.read. Null when the id is unknown or belongs to another project. */
  getIssue(access: ProjectAccess, issueId: string): Promise<IssueRecord | null>;
  /**
   * Requires issues.manage. Sets the status and audit-logs the change; a
   * status equal to the current one changes and logs nothing. Null when the
   * id is unknown or belongs to another project.
   */
  setIssueStatus(
    access: ProjectAccess,
    issueId: string,
    status: IssueStatus,
    sourceIp?: string,
  ): Promise<IssueRecord | null>;
}
