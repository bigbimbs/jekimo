/**
 * Durable queue in PostgreSQL. Producers enqueue inside the request that
 * acknowledges the work; consumers claim jobs with FOR UPDATE SKIP LOCKED so
 * several workers never take the same job, hold them for a visibility
 * timeout, and either ack (delete), retry with backoff, or dead-letter.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "./pool.js";
import { firstRow } from "./rows.js";
import type { Job, Queue } from "./types.js";

export interface QueuePolicy {
  /** How long a claimed job stays invisible to other consumers. */
  visibilityTimeoutMs: number;
  /** Attempts before a job is dead-lettered. */
  maxAttempts: number;
  /** First retry delay; doubles per attempt up to maxBackoffMs. */
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  visibilityTimeoutMs: 60_000,
  maxAttempts: 5,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

/**
 * Reads JEKIMO_QUEUE_VISIBILITY_SECONDS and JEKIMO_QUEUE_MAX_ATTEMPTS. The API
 * stamps max attempts on each job it enqueues; the worker applies the
 * visibility timeout when it claims jobs.
 */
export function queuePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<QueuePolicy> {
  const policy: Partial<QueuePolicy> = {};
  const visibility = Number(env.JEKIMO_QUEUE_VISIBILITY_SECONDS);
  if (env.JEKIMO_QUEUE_VISIBILITY_SECONDS && Number.isInteger(visibility) && visibility > 0)
    policy.visibilityTimeoutMs = visibility * 1000;
  const attempts = Number(env.JEKIMO_QUEUE_MAX_ATTEMPTS);
  if (env.JEKIMO_QUEUE_MAX_ATTEMPTS && Number.isInteger(attempts) && attempts > 0) policy.maxAttempts = attempts;
  return policy;
}

export type FailureDecision = { status: "dead" } | { status: "retry"; delayMs: number };

/** What happens to a job whose attempt number `attempts` (1-based) failed. */
export function decideFailure(
  attempts: number,
  maxAttempts: number,
  policy: Pick<QueuePolicy, "baseBackoffMs" | "maxBackoffMs">,
): FailureDecision {
  if (attempts >= maxAttempts) return { status: "dead" };
  const delayMs = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** Math.max(0, attempts - 1));
  return { status: "retry", delayMs };
}

/** A short, payload-free description of a failure for last_error. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "non-error thrown";
  return message.slice(0, 500);
}

interface JobRow {
  id: string;
  lease_id: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

export class PostgresQueue<T> implements Queue<T> {
  private readonly policy: QueuePolicy;

  constructor(
    private readonly pool: Pool,
    private readonly name: string,
    policy: Partial<QueuePolicy> = {},
  ) {
    this.policy = { ...DEFAULT_QUEUE_POLICY, ...policy };
  }

  async enqueue(payload: T): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      "INSERT INTO queue_jobs (queue, payload, max_attempts) VALUES ($1, $2::jsonb, $3) RETURNING id",
      [this.name, JSON.stringify(payload), this.policy.maxAttempts],
    );
    return firstRow(rows, "enqueue job").id;
  }

  async dequeue(limit: number): Promise<Job<T>[]> {
    // A job whose lease ran out on its last attempt crashed its consumer every
    // time; dead-letter it instead of redelivering it forever.
    await this.pool.query(
      `UPDATE queue_jobs SET status = 'dead', lease_id = NULL, updated_at = now(),
         last_error = coalesce(last_error, 'visibility timeout expired on final attempt')
       WHERE queue = $1 AND status = 'running' AND locked_until <= now() AND attempts >= max_attempts`,
      [this.name],
    );
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE queue_jobs j
       SET status = 'running', attempts = j.attempts + 1, lease_id = $3::uuid,
           locked_until = now() + make_interval(secs => $4::double precision / 1000), updated_at = now()
       FROM (
         SELECT id FROM queue_jobs
         WHERE queue = $1
           AND ((status = 'pending' AND run_at <= now())
             OR (status = 'running' AND locked_until <= now() AND attempts < max_attempts))
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       ) ready
       WHERE j.id = ready.id
       RETURNING j.id, j.lease_id, j.payload, j.attempts, j.max_attempts`,
      [this.name, limit, randomUUID(), this.policy.visibilityTimeoutMs],
    );
    return rows
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((r) => ({
        id: String(r.id),
        leaseId: r.lease_id,
        payload: r.payload as T,
        attempts: r.attempts,
        maxAttempts: r.max_attempts,
      }));
  }

  async ack(job: Job<T>): Promise<void> {
    await this.pool.query("DELETE FROM queue_jobs WHERE id = $1 AND lease_id = $2::uuid", [job.id, job.leaseId]);
  }

  async fail(job: Job<T>, error: unknown): Promise<"retry" | "dead"> {
    const decision = decideFailure(job.attempts, job.maxAttempts, this.policy);
    const lastError = describeError(error);
    if (decision.status === "dead") {
      await this.pool.query(
        `UPDATE queue_jobs SET status = 'dead', lease_id = NULL, locked_until = NULL, last_error = $3, updated_at = now()
         WHERE id = $1 AND lease_id = $2::uuid`,
        [job.id, job.leaseId, lastError],
      );
      return "dead";
    }
    await this.pool.query(
      `UPDATE queue_jobs SET status = 'pending', lease_id = NULL, locked_until = NULL, last_error = $3,
         run_at = now() + make_interval(secs => $4::double precision / 1000), updated_at = now()
       WHERE id = $1 AND lease_id = $2::uuid`,
      [job.id, job.leaseId, lastError, decision.delayMs],
    );
    return "retry";
  }
}
