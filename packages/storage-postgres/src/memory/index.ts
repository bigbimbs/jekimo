/**
 * In-memory implementations of the storage boundaries, for unit tests of the
 * API and worker. They follow the same contracts as the PostgreSQL classes
 * (project scoping, idempotent appends, lease-checked queue) but are not
 * durable and not meant for production.
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_PROJECT_ROLES,
  EVENT_KINDS,
  PROJECT_PERMISSIONS,
  type ProjectPermission,
  SEVERITIES,
  utcDay,
} from "@jekimo/event-schema";
import { assertProjectAccess, mintProjectAccess, type ProjectAccess } from "../access.js";
import type { IssueStatus } from "../constants/index.js";
import { decodeCursor, encodeCursor, searchWords } from "../event-store.js";
import { decodeIssueCursor, encodeIssueCursor, issueStatusAction, mergeEnvironments } from "../issues.js";
import { checkCounterIncrement, isUtcDay, normalizeRedactionRules } from "../project-settings.js";
import { DEFAULT_QUEUE_POLICY, decideFailure, describeError, QueueFullError, type QueuePolicy } from "../queue.js";
import type { IssuePage, IssueQuery } from "../types/index.js";
import type {
  Actor,
  AppendEvent,
  AuditEntry,
  DailyCounterIncrement,
  DailyCounters,
  EventPage,
  EventQuery,
  EventStore,
  EventStoreCapabilities,
  FingerprintSummary,
  IngestionKeyLookup,
  IngestionKeyRecord,
  IssueRecord,
  IssueSummary,
  Job,
  MetadataRepository,
  ProjectRecord,
  ProjectRetention,
  Queue,
  QueueStats,
  RedactionRules,
  SessionRecord,
  StoredEvent,
  UserRecord,
} from "../types.js";

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

interface MemoryUser extends UserRecord {
  passwordHash: string;
}

interface MemorySession {
  id: string;
  userId: string;
  tokenHash: Uint8Array;
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export class MemoryMetadataRepository implements MetadataRepository {
  readonly users: MemoryUser[] = [];
  readonly sessions: MemorySession[] = [];
  readonly projects: ProjectRecord[] = [];
  /** project id -> user id -> role name */
  readonly members = new Map<string, Map<string, string>>();
  /** project id -> role name -> permissions */
  readonly roles = new Map<string, Map<string, Set<ProjectPermission>>>();
  readonly keys: (IngestionKeyLookup & { name: string; createdAt: Date })[] = [];
  readonly audit: (AuditEntry & { occurredAt: Date })[] = [];
  readonly issues: IssueRecord[] = [];
  /** project id -> day -> counts */
  readonly counters = new Map<string, Map<string, DailyCounters>>();
  /** project id -> idempotency key -> when it was used */
  readonly counterKeys = new Map<string, Map<string, Date>>();
  /** project id -> redaction rules */
  readonly redactionRules = new Map<string, RedactionRules>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async countUsers(): Promise<number> {
    return this.users.length;
  }

  async createFirstAdmin(input: { email: string; passwordHash: string }): Promise<UserRecord | null> {
    if (this.users.length > 0) return null;
    return this.addUser(input.email, input.passwordHash, "admin");
  }

  /** Test helper: adds a user directly. */
  addUser(email: string, passwordHash: string, instanceRole: UserRecord["instanceRole"]): UserRecord {
    const user: MemoryUser = {
      id: randomUUID(),
      email,
      passwordHash,
      instanceRole,
      status: "active",
      createdAt: this.clock(),
    };
    this.users.push(user);
    const { passwordHash: _, ...record } = user;
    return record;
  }

  /** Test helper: adds or changes a membership with a role name defined in the project. */
  setMember(projectId: string, userId: string, role: string): void {
    if (!this.roles.get(projectId)?.has(role)) throw new Error(`no role ${role} in ${projectId}`);
    const members = this.members.get(projectId);
    if (!members) throw new Error(`no project ${projectId}`);
    members.set(userId, role);
  }

  /** Test helper: defines a custom role. */
  defineRole(projectId: string, name: string, permissions: ProjectPermission[]): void {
    const roles = this.roles.get(projectId);
    if (!roles) throw new Error(`no project ${projectId}`);
    roles.set(name, new Set(permissions));
  }

  async findUserForLogin(email: string): Promise<{ user: UserRecord; passwordHash: string } | null> {
    const u = this.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (!u) return null;
    const { passwordHash, ...user } = u;
    return { user, passwordHash };
  }

  async countFailedLogins(userId: string, since: Date): Promise<number> {
    return this.audit.filter((a) => a.action === "auth.login_failed" && a.targetId === userId && a.occurredAt >= since)
      .length;
  }

  async createSession(input: {
    userId: string;
    tokenHash: Uint8Array;
    csrfToken: string;
    expiresAt: Date;
  }): Promise<void> {
    const now = this.clock();
    this.sessions.push({
      id: randomUUID(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      csrfToken: input.csrfToken,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
  }

  async findSession(tokenHash: Uint8Array, now: Date): Promise<SessionRecord | null> {
    const s = this.sessions.find((x) => sameBytes(x.tokenHash, tokenHash));
    if (!s || s.revokedAt !== null || s.expiresAt <= now) return null;
    const u = this.users.find((x) => x.id === s.userId);
    if (u?.status !== "active") return null;
    const { passwordHash: _, ...user } = u;
    return {
      sessionId: s.id,
      user,
      csrfToken: s.csrfToken,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
    };
  }

  async touchSession(sessionId: string, now: Date): Promise<void> {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (s) s.lastSeenAt = now;
  }

  async revokeSession(sessionId: string, now: Date): Promise<void> {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (s && s.revokedAt === null) s.revokedAt = now;
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.audit.push({ ...entry, occurredAt: this.clock() });
  }

  async createProject(
    actor: Actor,
    input: { id: string; name: string; retentionDays: number; sourceIp?: string },
  ): Promise<ProjectRecord> {
    if (this.projects.some((p) => p.id === input.id)) throw new Error("duplicate project id");
    const project: ProjectRecord = {
      id: input.id,
      name: input.name,
      retentionDays: input.retentionDays,
      sampleRate: 1,
      disabled: false,
      createdAt: this.clock(),
    };
    this.projects.push(project);
    this.roles.set(input.id, new Map(Object.entries(DEFAULT_PROJECT_ROLES).map(([n, p]) => [n, new Set(p)])));
    this.members.set(input.id, new Map([[actor.userId, "admin"]]));
    await this.appendAudit({
      actorUserId: actor.userId,
      action: "project.created",
      targetType: "project",
      targetId: input.id,
      projectId: input.id,
    });
    return { ...project };
  }

  async listProjects(actor: Actor): Promise<ProjectRecord[]> {
    if (actor.instanceRole === "admin") return this.projects.map((p) => ({ ...p }));
    return this.projects.filter((p) => this.members.get(p.id)?.has(actor.userId)).map((p) => ({ ...p }));
  }

  async resolveProjectAccess(actor: Actor, projectId: string): Promise<ProjectAccess | null> {
    if (!this.projects.some((p) => p.id === projectId)) return null;
    const role = this.members.get(projectId)?.get(actor.userId);
    if (role === undefined && actor.instanceRole !== "admin") return null;
    let permissions: Set<ProjectPermission>;
    if (actor.instanceRole === "admin") {
      permissions = new Set(PROJECT_PERMISSIONS);
    } else {
      const granted = role === undefined ? undefined : this.roles.get(projectId)?.get(role);
      if (!granted) return null;
      permissions = new Set(granted);
    }
    return mintProjectAccess({ projectId, userId: actor.userId, permissions, viaInstanceAdmin: role === undefined });
  }

  async getProject(access: ProjectAccess): Promise<ProjectRecord> {
    assertProjectAccess(access);
    const project = this.projects.find((p) => p.id === access.projectId);
    if (!project) throw new Error(`no project ${access.projectId}`);
    return { ...project };
  }

  async createIngestionKey(
    access: ProjectAccess,
    input: { keyId: string; keyHash: Uint8Array; name: string },
  ): Promise<IngestionKeyRecord> {
    assertProjectAccess(access);
    if (!access.permissions.has("keys.manage")) throw new Error("missing permission keys.manage");
    const createdAt = this.clock();
    this.keys.push({
      keyId: input.keyId,
      projectId: access.projectId,
      keyHash: input.keyHash,
      revokedAt: null,
      expiresAt: null,
      projectDisabled: false,
      name: input.name,
      createdAt,
    });
    await this.appendAudit({
      actorUserId: access.userId,
      action: "ingestion_key.created",
      targetType: "ingestion_key",
      targetId: input.keyId,
      projectId: access.projectId,
      viaInstanceAdmin: access.viaInstanceAdmin,
    });
    return { keyId: input.keyId, projectId: access.projectId, name: input.name, createdAt };
  }

  async findIngestionKey(keyId: string): Promise<IngestionKeyLookup | null> {
    const k = this.keys.find((x) => x.keyId === keyId);
    if (!k) return null;
    const disabled = this.projects.find((p) => p.id === k.projectId)?.disabled ?? true;
    return {
      keyId: k.keyId,
      projectId: k.projectId,
      keyHash: k.keyHash,
      revokedAt: k.revokedAt,
      expiresAt: k.expiresAt,
      projectDisabled: disabled,
    };
  }

  async getProjectSettings(projectId: string): Promise<{ retentionDays: number; sampleRate: number } | null> {
    const p = this.projects.find((x) => x.id === projectId);
    return p ? { retentionDays: p.retentionDays, sampleRate: p.sampleRate } : null;
  }

  async upsertIssues(projectId: string, summaries: IssueSummary[]): Promise<void> {
    for (const s of summaries) {
      const i = this.issues.find((x) => x.projectId === projectId && x.fingerprint === s.fingerprint);
      if (!i) {
        const { environments, ...rest } = s;
        this.issues.push({
          ...rest,
          id: randomUUID(),
          projectId,
          status: "unresolved",
          environments: mergeEnvironments(environments ?? []),
        });
        continue;
      }
      if (i.status === "resolved" && s.lastSeen > (i.statusChangedAt ?? new Date(0))) {
        i.status = "unresolved";
        i.statusChangedAt = this.clock();
        await this.appendAudit({
          actorUserId: null,
          action: "issue.regressed",
          targetType: "issue",
          targetId: i.id,
          projectId,
          details: { from: "resolved", to: "unresolved" },
        });
      }
      i.eventCount = Math.max(i.eventCount, s.eventCount);
      if (s.firstSeen < i.firstSeen) i.firstSeen = s.firstSeen;
      if (s.lastSeen >= i.lastSeen) {
        i.lastSeen = s.lastSeen;
        i.lastSeverity = s.lastSeverity;
        if (s.lastEventId !== undefined) i.lastEventId = s.lastEventId;
      }
      i.environments = mergeEnvironments(i.environments, s.environments);
    }
  }

  async replaceIssueCounts(projectId: string, summaries: FingerprintSummary[]): Promise<void> {
    for (let n = this.issues.length - 1; n >= 0; n--) {
      const i = this.issues[n];
      if (!i || i.projectId !== projectId) continue;
      const s = summaries.find((x) => x.fingerprint === i.fingerprint);
      if (!s) this.issues.splice(n, 1);
      else Object.assign(i, { eventCount: s.eventCount, firstSeen: s.firstSeen, lastSeen: s.lastSeen });
    }
  }

  async listProjectRetention(): Promise<ProjectRetention[]> {
    return this.projects.map((p) => ({ projectId: p.id, retentionDays: p.retentionDays }));
  }

  async incrementDailyCounters(projectId: string, input: DailyCounterIncrement): Promise<boolean> {
    const counts = checkCounterIncrement(input);
    if (!this.projects.some((p) => p.id === projectId)) throw new Error(`no project ${projectId}`);
    if (input.idempotencyKey !== undefined) {
      const keys = this.counterKeys.get(projectId) ?? new Map<string, Date>();
      this.counterKeys.set(projectId, keys);
      if (keys.has(input.idempotencyKey)) return false;
      keys.set(input.idempotencyKey, this.clock());
    }
    const days = this.counters.get(projectId) ?? new Map<string, DailyCounters>();
    this.counters.set(projectId, days);
    const day = days.get(input.day) ?? { day: input.day, accepted: 0, rejected: 0, dropped: 0, sampled: 0 };
    days.set(input.day, {
      day: input.day,
      accepted: day.accepted + counts.accepted,
      rejected: day.rejected + counts.rejected,
      dropped: day.dropped + counts.dropped,
      sampled: day.sampled + counts.sampled,
    });
    return true;
  }

  async listDailyCounters(access: ProjectAccess, range: { from: string; to: string }): Promise<DailyCounters[]> {
    assertProjectAccess(access);
    if (!access.permissions.has("project.read")) throw new Error("missing permission project.read");
    if (!isUtcDay(range.from) || !isUtcDay(range.to))
      throw new RangeError("counter range must be UTC days, YYYY-MM-DD");
    return [...(this.counters.get(access.projectId)?.values() ?? [])]
      .filter((c) => c.day >= range.from && c.day <= range.to)
      .sort((a, b) => (a.day < b.day ? -1 : 1))
      .map((c) => ({ ...c }));
  }

  async pruneDailyCounters(beforeDay: string, keysBefore: Date): Promise<{ counters: number; keys: number }> {
    if (!isUtcDay(beforeDay)) throw new RangeError("beforeDay must be a UTC day, YYYY-MM-DD");
    let counters = 0;
    let keys = 0;
    for (const days of this.counters.values()) {
      for (const day of days.keys()) {
        if (day < beforeDay) {
          days.delete(day);
          counters++;
        }
      }
    }
    for (const used of this.counterKeys.values()) {
      for (const [key, at] of used) {
        if (at < keysBefore) {
          used.delete(key);
          keys++;
        }
      }
    }
    return { counters, keys };
  }

  async getRedactionRules(projectId: string): Promise<RedactionRules | null> {
    if (!this.projects.some((p) => p.id === projectId)) return null;
    const rules = this.redactionRules.get(projectId);
    return rules ? { keys: [...rules.keys], patterns: [...rules.patterns] } : { keys: [], patterns: [] };
  }

  async setRedactionRules(access: ProjectAccess, rules: RedactionRules): Promise<RedactionRules> {
    assertProjectAccess(access);
    if (!access.permissions.has("settings.manage")) throw new Error("missing permission settings.manage");
    const normalized = normalizeRedactionRules(rules);
    this.redactionRules.set(access.projectId, normalized);
    await this.appendAudit({
      actorUserId: access.userId,
      action: "project.redaction_rules_updated",
      targetType: "project",
      targetId: access.projectId,
      projectId: access.projectId,
      viaInstanceAdmin: access.viaInstanceAdmin,
      details: { keys: normalized.keys.length, patterns: normalized.patterns.length },
    });
    return { keys: [...normalized.keys], patterns: [...normalized.patterns] };
  }

  async listIssues(access: ProjectAccess, query: IssueQuery): Promise<IssuePage> {
    assertProjectAccess(access);
    if (!access.permissions.has("project.read")) throw new Error("missing permission project.read");
    const after = query.cursor === undefined ? undefined : decodeIssueCursor(query.cursor);
    const matches = this.issues
      .filter(
        (i) =>
          i.projectId === access.projectId &&
          (!query.statuses || query.statuses.includes(i.status)) &&
          (!query.kinds || query.kinds.includes(i.kind)) &&
          (!query.severities || query.severities.includes(i.lastSeverity)) &&
          (query.environment === undefined || i.environments.includes(query.environment)) &&
          (!query.from || i.lastSeen >= query.from) &&
          (!query.to || i.firstSeen < query.to) &&
          (!after ||
            i.lastSeen.getTime() < after.lastSeen.getTime() ||
            (i.lastSeen.getTime() === after.lastSeen.getTime() && i.id < after.id)),
      )
      .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const issues = matches.slice(0, query.limit).map((i) => structuredClone(i));
    const last = issues[issues.length - 1];
    return matches.length > query.limit && last ? { issues, nextCursor: encodeIssueCursor(last) } : { issues };
  }

  async getIssue(access: ProjectAccess, issueId: string): Promise<IssueRecord | null> {
    assertProjectAccess(access);
    if (!access.permissions.has("project.read")) throw new Error("missing permission project.read");
    const i = this.issues.find((x) => x.projectId === access.projectId && x.id === issueId);
    return i ? structuredClone(i) : null;
  }

  async setIssueStatus(
    access: ProjectAccess,
    issueId: string,
    status: IssueStatus,
    sourceIp?: string,
  ): Promise<IssueRecord | null> {
    assertProjectAccess(access);
    if (!access.permissions.has("issues.manage")) throw new Error("missing permission issues.manage");
    const i = this.issues.find((x) => x.projectId === access.projectId && x.id === issueId);
    if (!i) return null;
    if (i.status !== status) {
      const from = i.status;
      i.status = status;
      i.statusChangedAt = this.clock();
      await this.appendAudit({
        actorUserId: access.userId,
        action: issueStatusAction(status),
        targetType: "issue",
        targetId: issueId,
        projectId: access.projectId,
        viaInstanceAdmin: access.viaInstanceAdmin,
        details: { from, to: status },
        ...(sourceIp !== undefined && { sourceIp }),
      });
    }
    return structuredClone(i);
  }
}

export class MemoryEventStore implements EventStore {
  readonly capabilities: EventStoreCapabilities = { textSearch: true };
  readonly rows: (StoredEvent & { projectId: string })[] = [];
  readonly dedupe = new Map<string, Date>();

  async appendEvents(projectId: string, events: AppendEvent[]): Promise<{ inserted: string[] }> {
    const inserted: string[] = [];
    for (const e of events) {
      if (e.event.project_id !== projectId) throw new RangeError("event project_id does not match the append scope");
      const key = `${projectId}\u0000${e.event.event_id}`;
      if (this.dedupe.has(key)) continue;
      this.dedupe.set(key, e.receivedAt);
      const stored: StoredEvent & { projectId: string } = {
        projectId,
        receivedAt: e.receivedAt,
        keyId: e.keyId,
        event: structuredClone(e.event),
      };
      if (e.skewMs !== undefined) stored.skewMs = e.skewMs;
      this.rows.push(stored);
      inserted.push(e.event.event_id);
    }
    return { inserted };
  }

  async queryEvents(projectId: string, query: EventQuery): Promise<EventPage> {
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null) throw new RangeError("invalid cursor");
    const severities = query.severities?.filter((s) => (SEVERITIES as readonly string[]).includes(s));
    const kinds = query.kinds?.filter((k) => (EVENT_KINDS as readonly string[]).includes(k));
    const words = query.text === undefined ? undefined : searchWords(query.text);
    if (words?.length === 0) throw new RangeError("text has no words to search for");
    const matching = this.rows
      .filter((r) => r.projectId === projectId && r.receivedAt >= query.from && r.receivedAt < query.to)
      .filter((r) => !severities || severities.length === 0 || severities.includes(r.event.severity))
      .filter((r) => !kinds || kinds.length === 0 || kinds.includes(r.event.kind))
      .filter((r) => query.environment === undefined || r.event.environment === query.environment)
      .filter((r) => query.release === undefined || r.event.release === query.release)
      .filter((r) => query.fingerprint === undefined || r.event.fingerprint === query.fingerprint)
      .filter((r) => {
        if (!words) return true;
        const have = new Set(searchWords(r.event.message));
        return words.every((w) => have.has(w));
      })
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || (a.event.event_id < b.event.event_id ? 1 : -1))
      .filter(
        (r) =>
          !cursor ||
          r.receivedAt < cursor.receivedAt ||
          (r.receivedAt.getTime() === cursor.receivedAt.getTime() && r.event.event_id < cursor.eventId),
      );
    const page: EventPage = {
      events: matching.slice(0, query.limit).map(({ projectId: _, ...e }) => structuredClone(e)),
    };
    const last = page.events.at(-1);
    if (matching.length > query.limit && last) {
      page.nextCursor = encodeCursor(last.receivedAt, last.event.event_id);
    }
    return page;
  }

  async getEvent(projectId: string, eventId: string): Promise<StoredEvent | null> {
    const found = this.rows
      .filter((r) => r.projectId === projectId && r.event.event_id === eventId)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())[0];
    if (!found) return null;
    const { projectId: _, ...e } = found;
    return structuredClone(e);
  }

  async summarizeFingerprints(projectId: string, fingerprints?: string[]): Promise<FingerprintSummary[]> {
    const out = new Map<string, FingerprintSummary>();
    for (const r of this.rows) {
      if (r.projectId !== projectId) continue;
      if (fingerprints && !fingerprints.includes(r.event.fingerprint)) continue;
      const s = out.get(r.event.fingerprint);
      if (!s)
        out.set(r.event.fingerprint, {
          fingerprint: r.event.fingerprint,
          eventCount: 1,
          firstSeen: r.receivedAt,
          lastSeen: r.receivedAt,
        });
      else {
        s.eventCount++;
        if (r.receivedAt < s.firstSeen) s.firstSeen = r.receivedAt;
        if (r.receivedAt > s.lastSeen) s.lastSeen = r.receivedAt;
      }
    }
    return [...out.values()];
  }

  async expireDay(projectId: string, day: string): Promise<{ deleted: number }> {
    let deleted = 0;
    for (let n = this.rows.length - 1; n >= 0; n--) {
      const r = this.rows[n];
      if (r && r.projectId === projectId && utcDay(r.receivedAt) === day) {
        this.rows.splice(n, 1);
        deleted++;
      }
    }
    return { deleted };
  }

  archiveDay(): Promise<never> {
    return Promise.reject(
      new Error("archiveDay is not implemented: object storage is Phase 2 (docs/object-storage.md)"),
    );
  }

  async listDays(): Promise<string[]> {
    return [...new Set(this.rows.map((r) => utcDay(r.receivedAt)))].sort();
  }

  async prepareDays(): Promise<void> {}

  async pruneDedupe(before: Date): Promise<number> {
    let n = 0;
    for (const [k, at] of this.dedupe) {
      if (at < before) {
        this.dedupe.delete(k);
        n++;
      }
    }
    return n;
  }
}

interface MemoryJob<T> {
  id: string;
  payload: T;
  status: "pending" | "running" | "dead";
  attempts: number;
  runAt: number;
  createdAt: number;
  lockedUntil: number;
  leaseId: string | null;
  lastError?: string;
}

export class MemoryQueue<T> implements Queue<T> {
  readonly jobs: MemoryJob<T>[] = [];
  private readonly policy: QueuePolicy;
  private nextId = 1;
  /** When set, enqueue throws, to test the 503 path. */
  failEnqueue = false;

  constructor(
    policy: Partial<QueuePolicy> = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.policy = { ...DEFAULT_QUEUE_POLICY, ...policy };
  }

  async enqueue(payload: T): Promise<string> {
    if (this.failEnqueue) throw new Error("queue unavailable");
    if (this.jobs.filter((j) => j.status !== "dead").length >= this.policy.maxDepth) {
      throw new QueueFullError(this.policy.maxDepth);
    }
    const id = String(this.nextId++);
    this.jobs.push({
      id,
      payload: structuredClone(payload),
      status: "pending",
      attempts: 0,
      runAt: this.clock(),
      createdAt: this.clock(),
      lockedUntil: 0,
      leaseId: null,
    });
    return id;
  }

  async dequeue(limit: number): Promise<Job<T>[]> {
    const now = this.clock();
    const out: Job<T>[] = [];
    for (const j of this.jobs) {
      if (j.status === "running" && j.lockedUntil <= now && j.attempts >= this.policy.maxAttempts) {
        j.status = "dead";
        j.leaseId = null;
      }
    }
    for (const j of this.jobs) {
      if (out.length >= limit) break;
      const ready = (j.status === "pending" && j.runAt <= now) || (j.status === "running" && j.lockedUntil <= now);
      if (!ready) continue;
      j.status = "running";
      j.attempts++;
      j.leaseId = randomUUID();
      j.lockedUntil = now + this.policy.visibilityTimeoutMs;
      out.push({
        id: j.id,
        leaseId: j.leaseId,
        payload: structuredClone(j.payload),
        attempts: j.attempts,
        maxAttempts: this.policy.maxAttempts,
      });
    }
    return out;
  }

  async ack(job: Job<T>): Promise<void> {
    const n = this.jobs.findIndex((j) => j.id === job.id && j.leaseId === job.leaseId);
    if (n >= 0) this.jobs.splice(n, 1);
  }

  async fail(job: Job<T>, error: unknown): Promise<"retry" | "dead"> {
    const decision = decideFailure(job.attempts, job.maxAttempts, this.policy);
    const j = this.jobs.find((x) => x.id === job.id && x.leaseId === job.leaseId);
    if (j) {
      j.leaseId = null;
      j.lastError = describeError(error);
      if (decision.status === "dead") j.status = "dead";
      else Object.assign(j, { status: "pending", runAt: this.clock() + decision.delayMs });
    }
    return decision.status;
  }

  async stats(): Promise<QueueStats> {
    const live = this.jobs.filter((j) => j.status !== "dead");
    const pending = live.filter((j) => j.status === "pending").length;
    const oldest = Math.min(...live.map((j) => j.createdAt));
    return {
      pending,
      running: live.length - pending,
      depth: live.length,
      dead: this.jobs.length - live.length,
      oldestAgeMs: live.length === 0 ? null : Math.max(0, this.clock() - oldest),
    };
  }
}
