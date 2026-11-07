import type { IngestRequestResult } from "@jekimo/event-schema";
import type {
  DiskMonitor,
  IngestionKeyLookup,
  IngestJob,
  IngestLimitStore,
  IngestLimits,
  IngestUsage,
  MetadataRepository,
  Queue,
} from "@jekimo/storage-postgres";
import type { IngestService } from "../modules/ingest/service.js";

export interface IngestServiceDeps {
  metadata: MetadataRepository;
  queue: Queue<IngestJob>;
  clock: () => Date;
  /** Absent only in tests: ingest is then not limited. */
  limits?: IngestLimitStore;
  limitDefaults: IngestLimits;
  /** Absent only in tests: disk space is then not checked. */
  disk?: DiskMonitor;
}

export interface IngestRouteOptions {
  service: IngestService;
  maxBodyBytes?: number;
}

export interface IngestContext {
  projectId: string;
  keyId: string;
  receivedAt: Date;
  limits?: IngestLimits;
}

export interface IngestAuthentication {
  record: IngestionKeyLookup;
  receivedAt: Date;
  limits?: IngestLimits;
  usage?: IngestUsage;
}

export interface ParsedIngestBody {
  json: unknown;
  bytes: number;
}

export type ValidatedIngest = Extract<IngestRequestResult, { ok: true }>;
