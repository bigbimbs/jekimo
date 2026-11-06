/**
 * In-memory implementations of the storage boundaries, for unit tests of the
 * API and worker. They follow the same contracts as the PostgreSQL classes
 * (project scoping, idempotent appends, lease-checked queue) but are not
 * durable and not meant for production.
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_PROJECT_ROLES, PROJECT_PERMISSIONS, SEVERITIES, utcDay, type ProjectPermission } from "@jekimo/event-schema";
import { assertProjectAccess, mintProjectAccess, type ProjectAccess } from "../access.js";
import { decodeCursor, encodeCursor } from "../event-store.js";
import { decideFailure, DEFAULT_QUEUE_POLICY, describeError, type QueuePolicy } from "../queue.js";
import type {
  Actor,
  AppendEvent,
  AuditEntry,
  EventPage,
  EventQuery,
  EventStore,
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
    const user: MemoryUser = { id: randomUUID(), email, passwordHash, instanceRole, status: "active", createdAt: this.clock() };
    this.users.push(user);
    const { passwordHash: _, ...record } = user;
    return record;
  }

  /** Test helper: adds or changes a membership with a role name defined in the project. */
  setMember(projectId: string, userId: string, role: string): void {
    if (!this.roles.get(projectId)?.has(role)) throw new Error(`no role ${role} in ${projectId}`);
    this.members.get(projectId)!.set(userId, role);
  }

  /** Test helper: defines a custom role. */
  defineRole(projectId: string, name: string, permissions: ProjectPermission[]): void {
    this.roles.get(projectId)!.set(name, new Set(permissions));
  }

  async findUserForLogin(email: string): Promise<{ user: UserRecord; passwordHash: string } | null> {
    const u = this.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (!u) return null;
    const { passwordHash, ...user } = u;
    return { user, passwordHash };
  }

  async countFailedLogins(userId: string, since: Date): Promise<number> {
    return this.audit.filter((a) => a.action === "auth.login_failed" && a.targetId === userId && a.occurredAt >= since).length;
  }

  async createSession(input: { userId: string; tokenHash: Uint8Array; csrfToken: string; expiresAt: Date }): Promise<void> {
    const now = this.clock();
    this.sessions.push({ id: randomUUID(), userId: input.userId, tokenHash: input.tokenHash, csrfToken: input.csrfToken, createdAt: now, lastSeenAt: now, expiresAt: input.expiresAt, revokedAt: null });
  }

  async findSession(tokenHash: Uint8Array, now: Date): Promise<SessionRecord | null> {
    const s = this.sessions.find((x) => sameBytes(x.tokenHash, tokenHash));
    if (!s || s.revokedAt !== null || s.expiresAt <= now) return null;
    const u = this.users.find((x) => x.id === s.userId);
    if (!u || u.status !== "active") return null;
    const { passwordHash: _, ...user } = u;
    return { sessionId: s.id, user, csrfToken: s.csrfToken, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt };
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

  async createProject(actor: Actor, input: { id: string; name: string; retentionDays: number; sourceIp?: string }): Promise<ProjectRecord> {
    if (this.projects.some((p) => p.id === input.id)) throw new Error("duplicate project id");
    const project: ProjectRecord = { id: input.id, name: input.name, retentionDays: input.retentionDays, sampleRate: 1, disabled: false, createdAt: this.clock() };
    this.projects.push(project);
    this.roles.set(input.id, new Map(Object.entries(DEFAULT_PROJECT_ROLES).map(([n, p]) => [n, new Set(p)])));
    this.members.set(input.id, new Map([[actor.userId, "admin"]]));
    await this.appendAudit({ actorUserId: actor.userId, action: "project.created", targetType: "project", targetId: input.id, projectId: input.id });
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
    const permissions = actor.instanceRole === "admin" ? new Set(PROJECT_PERMISSIONS) : new Set(this.roles.get(projectId)!.get(role!)!);
    return mintProjectAccess({ projectId, userId: actor.userId, permissions, viaInstanceAdmin: role === undefined });
  }

  async getProject(access: ProjectAccess): Promise<ProjectRecord> {
    assertProjectAccess(access);
    return { ...this.projects.find((p) => p.id === access.projectId)! };
  }

  async createIngestionKey(access: ProjectAccess, input: { keyId: string; keyHash: Uint8Array; name: string }): Promise<IngestionKeyRecord> {
    assertProjectAccess(access);
    if (!access.permissions.has("keys.manage")) throw new Error("missing permission keys.manage");
    const createdAt = this.clock();
    this.keys.push({ keyId: input.keyId, projectId: access.projectId, keyHash: input.keyHash, revokedAt: null, expiresAt: null, projectDisabled: false, name: input.name, createdAt });
    await this.appendAudit({ actorUserId: access.userId, action: "ingestion_key.created", targetType: "ingestion_key", targetId: input.keyId, projectId: access.projectId, viaInstanceAdmin: access.viaInstanceAdmin });
    return { keyId: input.keyId, projectId: access.projectId, name: input.name, createdAt };
  }

  async findIngestionKey(keyId: string): Promise<IngestionKeyLookup | null> {
    const k = this.keys.find((x) => x.keyId === keyId);
    if (!k) return null;
    const disabled = this.projects.find((p) => p.id === k.projectId)?.disabled ?? true;
    return { keyId: k.keyId, projectId: k.projectId, keyHash: k.keyHash, revokedAt: k.revokedAt, expiresAt: k.expiresAt, projectDisabled: disabled };
  }

  async getProjectSettings(projectId: string): Promise<{ retentionDays: number; sampleRate: number } | null> {
    const p = this.projects.find((x) => x.id === projectId);
    return p ? { retentionDays: p.retentionDays, sampleRate: p.sampleRate } : null;
  }

  async upsertIssues(projectId: string, summaries: IssueSummary[]): Promise<void> {
    for (const s of summaries) {
      const i = this.issues.find((x) => x.projectId === projectId && x.fingerprint === s.fingerprint);
      if (!i) {
        this.issues.push({ ...s, projectId, status: "unresolved" });
        continue;
      }
      i.eventCount = Math.max(i.eventCount, s.eventCount);
      if (s.firstSeen < i.firstSeen) i.firstSeen = s.firstSeen;
      if (s.lastSeen >= i.lastSeen) {
        i.lastSeen = s.lastSeen;
        i.lastSeverity = s.lastSeverity;
      }
    }
  }

  async replaceIssueCounts(projectId: string, summaries: FingerprintSummary[]): Promise<void> {
    for (let n = this.issues.length - 1; n >= 0; n--) {
      const i = this.issues[n]!;
      if (i.projectId !== projectId) continue;
      const s = summaries.find((x) => x.fingerprint === i.fingerprint);
      if (!s) this.issues.splice(n, 1);
      else Object.assign(i, { eventCount: s.eventCount, firstSeen: s.firstSeen, lastSeen: s.lastSeen });
    }
  }

  async listProjectRetention(): Promise<ProjectRetention[]> {
    return this.projects.map((p) => ({ projectId: p.id, retentionDays: p.retentionDays }));
  }
}

export class MemoryEventStore implements EventStore {
  readonly rows: (StoredEvent & { projectId: string })[] = [];
  readonly dedupe = new Map<string, Date>();

  async appendEvents(projectId: string, events: AppendEvent[]): Promise<{ inserted: string[] }> {
    const inserted: string[] = [];
    for (const e of events) {
      if (e.event.project_id !== projectId) throw new RangeError("event project_id does not match the append scope");
      const key = `${projectId}\u0000${e.event.event_id}`;
      if (this.dedupe.has(key)) continue;
      this.dedupe.set(key, e.receivedAt);
      const stored: StoredEvent & { projectId: string } = { projectId, receivedAt: e.receivedAt, keyId: e.keyId, event: structuredClone(e.event) };
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
    const matching = this.rows
      .filter((r) => r.projectId === projectId && r.receivedAt >= query.from && r.receivedAt < query.to)
      .filter((r) => !severities || severities.length === 0 || severities.includes(r.event.severity))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || (a.event.event_id < b.event.event_id ? 1 : -1))
      .filter(
        (r) =>
          !cursor ||
          r.receivedAt < cursor.receivedAt ||
          (r.receivedAt.getTime() === cursor.receivedAt.getTime() && r.event.event_id < cursor.eventId),
      );
    const page: EventPage = { events: matching.slice(0, query.limit).map(({ projectId: _, ...e }) => structuredClone(e)) };
    if (matching.length > query.limit) {
      const last = page.events[page.events.length - 1]!;
      page.nextCursor = encodeCursor(last.receivedAt, last.event.event_id);
    }
    return page;
  }

  async summarizeFingerprints(projectId: string, fingerprints?: string[]): Promise<FingerprintSummary[]> {
    const out = new Map<string, FingerprintSummary>();
    for (const r of this.rows) {
      if (r.projectId !== projectId) continue;
      if (fingerprints && !fingerprints.includes(r.event.fingerprint)) continue;
      const s = out.get(r.event.fingerprint);
      if (!s) out.set(r.event.fingerprint, { fingerprint: r.event.fingerprint, eventCount: 1, firstSeen: r.receivedAt, lastSeen: r.receivedAt });
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
      const r = this.rows[n]!;
      if (r.projectId === projectId && utcDay(r.receivedAt) === day) {
        this.rows.splice(n, 1);
        deleted++;
      }
    }
    return { deleted };
  }

  archiveDay(): Promise<never> {
    return Promise.reject(new Error("archiveDay is not implemented: object storage is Phase 2 (docs/object-storage.md)"));
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

  constructor(policy: Partial<QueuePolicy> = {}, private readonly clock: () => number = Date.now) {
    this.policy = { ...DEFAULT_QUEUE_POLICY, ...policy };
  }

  async enqueue(payload: T): Promise<string> {
    if (this.failEnqueue) throw new Error("queue unavailable");
    const id = String(this.nextId++);
    this.jobs.push({ id, payload: structuredClone(payload), status: "pending", attempts: 0, runAt: this.clock(), lockedUntil: 0, leaseId: null });
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
      out.push({ id: j.id, leaseId: j.leaseId, payload: structuredClone(j.payload), attempts: j.attempts, maxAttempts: this.policy.maxAttempts });
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
}
