import type {
  DiskMonitor,
  EventStore,
  IngestJob,
  IngestLimitStore,
  MetadataRepository,
  Queue,
} from "@jekimo/storage-postgres";
import type { FastifyServerOptions } from "fastify";
import type { PasswordHasher } from "./auth.js";
import type { ApiConfig } from "./config.js";

export interface AppDeps {
  metadata: MetadataRepository;
  events: EventStore;
  queue: Queue<IngestJob>;
  /** Absent only in tests: ingest is then not limited. */
  limits?: IngestLimitStore;
  /** Absent only in tests: disk space is then not checked. */
  disk?: DiskMonitor;
  config?: Partial<ApiConfig>;
  /** The one-time setup token, or null when setup is closed. */
  setupToken?: string | null;
  hasher?: PasswordHasher;
  clock?: () => Date;
  /**
   * Dependency checks for `GET /readyz`, by name. Each resolves when the
   * dependency is reachable. Defaults to a metadata read as "database".
   */
  readiness?: Record<string, () => Promise<unknown>>;
  /** Fastify logger options; false in tests. */
  logger?: FastifyServerOptions["logger"];
  /** Called for every route as it is registered, so tests can enumerate them. */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}
