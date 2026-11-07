import type { EventEnvelope } from "@jekimo/event-schema";

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
  stats(): Promise<QueueStats>;
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

export interface QueuePolicy {
  /** How long a claimed job stays invisible to other consumers. */
  visibilityTimeoutMs: number;
  /** Attempts before a job is dead-lettered. */
  maxAttempts: number;
  /** First retry delay; doubles per attempt up to maxBackoffMs. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Pending plus running jobs above which enqueue throws QueueFullError. */
  maxDepth: number;
}

export type FailureDecision = { status: "dead" } | { status: "retry"; delayMs: number };
