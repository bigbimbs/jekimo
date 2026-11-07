import type { ProjectPermission } from "@jekimo/event-schema";
import type { AppendEvent, DiskMonitor, IngestJob } from "@jekimo/storage-postgres";
import {
  MemoryEventStore,
  MemoryIngestLimitStore,
  MemoryMetadataRepository,
  MemoryQueue,
} from "@jekimo/storage-postgres/memory";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { generateIngestionKey } from "../src/keys.js";
import type { PasswordHasher } from "../src/passwords.js";
import { CSRF_HEADER, SESSION_COOKIE } from "../src/session.js";

/** Fast stand-in for Argon2id in unit tests. One test exercises the real hasher. */
export const fakeHasher: PasswordHasher = {
  hash: async (pw) => `fake$${pw}`,
  verify: async (hash, pw) => hash === `fake$${pw}`,
};

export const PASSWORD = "correct-horse-battery";
export const SETUP_TOKEN = "synthetic-setup-token-for-tests";

export interface Harness {
  app: FastifyInstance;
  metadata: MemoryMetadataRepository;
  events: MemoryEventStore;
  queue: MemoryQueue<IngestJob>;
  limits: MemoryIngestLimitStore;
  now: { value: Date };
}

export async function harness(
  options: {
    setupToken?: string | null;
    config?: Parameters<typeof buildApp>[0]["config"];
    queueMaxDepth?: number;
    disk?: DiskMonitor;
  } = {},
): Promise<Harness> {
  const now = { value: new Date("2026-11-05T09:15:00.000Z") };
  const metadata = new MemoryMetadataRepository(() => now.value);
  const events = new MemoryEventStore();
  const queue = new MemoryQueue<IngestJob>(
    options.queueMaxDepth === undefined ? {} : { maxDepth: options.queueMaxDepth },
  );
  const limits = new MemoryIngestLimitStore(metadata);
  const app = await buildApp({
    metadata,
    events,
    queue,
    limits,
    ...(options.disk && { disk: options.disk }),
    hasher: fakeHasher,
    setupToken: options.setupToken ?? null,
    clock: () => now.value,
    ...(options.config && { config: options.config }),
  });
  return { app, metadata, events, queue, limits, now };
}

export interface SignedIn {
  userId: string;
  cookie: string;
  csrf: string;
  headers: Record<string, string>;
}

export async function signIn(h: Harness, email: string, role: "admin" | "member" = "member"): Promise<SignedIn> {
  const user = h.metadata.addUser(email, await fakeHasher.hash(PASSWORD), role);
  const res = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
  const csrf = res.json().csrf_token as string;
  return {
    userId: user.id,
    cookie: `${SESSION_COOKIE}=${cookie.value}`,
    csrf,
    headers: { cookie: `${SESSION_COOKIE}=${cookie.value}`, [CSRF_HEADER]: csrf },
  };
}

/** Creates a project owned by `owner` and a key for it, directly in storage. */
export async function projectWithKey(
  h: Harness,
  owner: SignedIn,
  id = "prj_test",
): Promise<{ projectId: string; key: string; keyId: string }> {
  await h.metadata.createProject(
    { userId: owner.userId, instanceRole: "member" },
    { id, name: "Test project", retentionDays: 30 },
  );
  const access = await h.metadata.resolveProjectAccess({ userId: owner.userId, instanceRole: "member" }, id);
  const k = generateIngestionKey();
  await h.metadata.createIngestionKey(access!, { keyId: k.keyId, keyHash: k.keyHash, name: "test" });
  return { projectId: id, key: k.key, keyId: k.keyId };
}

export function setRole(
  h: Harness,
  projectId: string,
  userId: string,
  role: string,
  permissions?: ProjectPermission[],
): void {
  if (permissions) h.metadata.defineRole(projectId, role, permissions);
  h.metadata.setMember(projectId, userId, role);
}

export function ingestEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: "01JBQ4Z3H8X9T2K7M5N6P8R9SV",
    timestamp: "2026-11-05T09:14:33.412Z",
    kind: "log",
    severity: "info",
    message: "synthetic test event",
    ...overrides,
  };
}

/** Writes one stored-form event straight into the event store, as the worker would. */
export async function storeEvent(
  h: Harness,
  projectId: string,
  overrides: Record<string, unknown> = {},
  receivedAt: Date = h.now.value,
): Promise<void> {
  const event = { ...ingestEvent(), fingerprint: "fp-test", ...overrides, project_id: projectId };
  await h.events.appendEvents(projectId, [{ receivedAt, keyId: "0123456789AB", event: event as AppendEvent["event"] }]);
}
