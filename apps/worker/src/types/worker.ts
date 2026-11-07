import type { DiskMonitor, EventStore, IngestJob, MetadataRepository, Queue } from "@jekimo/storage-postgres";
import type { Logger } from "pino";

export interface WorkerOptions {
  queue: Queue<IngestJob>;
  metadata: MetadataRepository;
  events: EventStore;
  log: Logger;
  batchSize: number;
  pollMs: number;
  expiryIntervalMs: number;
  auditLogDays?: number;
  clock?: () => Date;
  disk?: DiskMonitor;
  /** Default 60000. */
  diskCheckIntervalMs?: number;
  retentionDefaultDays?: number;
  retentionMaxDays?: number;
}
