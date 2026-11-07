/**
 * The worker loop: drain the ingest queue in batches, ack or fail each job,
 * and run the expiry pass on an interval. Logs carry job ids, project ids,
 * and counts, never event payloads.
 */

import type { EventStore, IngestJob, MetadataRepository, Queue } from "@jekimo/storage-postgres";
import type { Logger } from "pino";
import { processIngestJob, runExpiryPass } from "./process.js";
import { RedactorCache } from "./redact.js";

export interface WorkerOptions {
  queue: Queue<IngestJob>;
  metadata: MetadataRepository;
  events: EventStore;
  log: Logger;
  batchSize: number;
  pollMs: number;
  expiryIntervalMs: number;
  /** Audit log retention (JEKIMO_AUDIT_LOG_DAYS). */
  auditLogDays?: number;
  clock?: () => Date;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export class Worker {
  private readonly abort = new AbortController();
  private readonly clock: () => Date;
  private lastExpiry = 0;
  private running: Promise<void> | undefined;

  constructor(private readonly opts: WorkerOptions) {
    this.clock = opts.clock ?? (() => new Date());
  }

  /** Claims one batch and processes it. Returns the number of jobs claimed. */
  async drainOnce(): Promise<number> {
    const jobs = await this.opts.queue.dequeue(this.opts.batchSize);
    // Redaction rules are read once per project per batch, never kept longer.
    const redactors = new RedactorCache(this.opts.metadata);
    for (const job of jobs) {
      const log = this.opts.log.child({ job_id: job.id, project_id: job.payload.project_id, attempt: job.attempts });
      try {
        const result = await processIngestJob(job.payload, this.opts, { jobId: job.id, redactors });
        await this.opts.queue.ack(job);
        if (!result.projectFound) {
          log.warn("project no longer exists; dropped job");
          continue;
        }
        // Ids, paths, and codes only: never the event's content.
        for (const d of result.dropped) {
          log.warn(
            { index: d.index, event_id: d.eventId, errors: d.errors },
            "event failed stored validation; dropped",
          );
        }
        log.info(
          {
            received: result.received,
            inserted: result.inserted,
            sampled_out: result.sampledOut,
            dropped: result.dropped.length,
          },
          "job processed",
        );
      } catch (err) {
        const outcome = await this.opts.queue.fail(job, err);
        const e = err as Error;
        log[outcome === "dead" ? "error" : "warn"](
          { err: { type: e.name, message: e.message }, outcome },
          "job failed",
        );
      }
    }
    return jobs.length;
  }

  async expireIfDue(): Promise<void> {
    const now = this.clock();
    if (now.getTime() - this.lastExpiry < this.opts.expiryIntervalMs) return;
    this.lastExpiry = now.getTime();
    try {
      const result = await runExpiryPass(this.opts, now, this.clock);
      this.opts.log.info(
        {
          deleted_events: result.deletedEvents,
          projects: result.projectsTouched,
          dedupe_pruned: result.dedupePruned,
          counters_pruned: result.countersPruned,
          audit_pruned: result.auditPruned,
        },
        "expiry pass done",
      );
    } catch (err) {
      const e = err as Error;
      this.opts.log.error({ err: { type: e.name, message: e.message } }, "expiry pass failed");
    }
  }

  start(): void {
    this.running ??= this.loop();
  }

  private async loop(): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      await this.expireIfDue();
      let claimed = 0;
      try {
        claimed = await this.drainOnce();
      } catch (err) {
        const e = err as Error;
        this.opts.log.error({ err: { type: e.name, message: e.message } }, "dequeue failed");
      }
      // Keep going while there is work; otherwise wait for the next poll.
      if (claimed < this.opts.batchSize) await sleep(this.opts.pollMs, signal);
    }
  }

  /** Finishes the current batch, then stops. */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.running;
  }
}
