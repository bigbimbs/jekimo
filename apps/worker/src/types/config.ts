export interface WorkerConfig {
  logLevel: string;
  /** Jobs claimed per dequeue. Each job is one ingest request of up to 100 events. */
  batchSize: number;
  /** Wait between polls when the queue is empty. */
  pollMs: number;
  /** docs/retention.md requires an expiry pass at least every 15 minutes. */
  expiryIntervalMinutes: number;
  retentionDefaultDays: number;
  retentionMaxDays: number;
  auditLogDays: number;
}
