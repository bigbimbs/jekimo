/**
 * The worker loop: drain the ingest queue in batches, ack or fail each job,
 * and run the expiry pass on an interval. Logs carry job ids, project ids,
 * and counts, never event payloads.
 */

import type { DiskLevel } from "@jekimo/event-schema";
import type { DiskMonitor, EventStore, IngestJob, MetadataRepository, Queue } from "@jekimo/storage-postgres";
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
  auditLogDays?: number;
  clock?: () => Date;
  disk?: DiskMonitor;
  /** Default 60000. */
  diskCheckIntervalMs?: number;
  retentionDefaultDays?: number;
  retentionMaxDays?: number;
}

/** docs/retention.md, "Disk safety". */
const EMERGENCY_EXPIRY_INTERVAL_MS = 60_000;

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
  private lastDiskCheck = Number.NEGATIVE_INFINITY;
  private diskLevel: DiskLevel | undefined;
  /** docs/retention.md: from the critical level until free space is back above the warning level. */
  emergency = false;
  /** A crashed or failed pass may have removed events without recounting their issues. */
  private recountAll = true;

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

  async checkDiskIfDue(): Promise<void> {
    const disk = this.opts.disk;
    if (!disk) return;
    const now = this.clock().getTime();
    if (now - this.lastDiskCheck < (this.opts.diskCheckIntervalMs ?? 60_000)) return;
    this.lastDiskCheck = now;
    const status = await disk.status();
    // Never delete data early on an unknown reading; the API already fails closed.
    if (status.freePercent === null) return;
    const level = status.level;
    if (level !== this.diskLevel) {
      const previous = this.diskLevel ?? null;
      this.diskLevel = level;
      const fields = { level, previous, free_percent: Math.round(status.freePercent * 10) / 10 };
      // `level` is pino's own key, so the log line names it disk_level.
      const line = { disk_level: level, previous, free_percent: fields.free_percent };
      if (level === "ok") this.opts.log.info(line, "disk level changed");
      else this.opts.log[level === "warn" ? "warn" : "error"](line, "disk level changed");
      if (previous !== null || level !== "ok") {
        try {
          await this.opts.metadata.appendAudit({ action: "instance.disk_level_changed", details: fields });
        } catch (err) {
          const e = err as Error;
          this.opts.log.warn({ err: { type: e.name, message: e.message } }, "disk audit entry failed");
        }
      }
    }
    if (level === "critical" || level === "full") {
      if (!this.emergency) {
        this.emergency = true;
        this.lastExpiry = 0; // run the first emergency pass now
      }
    } else if (level === "ok") {
      this.emergency = false;
    }
  }

  async expireIfDue(): Promise<void> {
    const now = this.clock();
    const interval = this.emergency ? EMERGENCY_EXPIRY_INTERVAL_MS : this.opts.expiryIntervalMs;
    if (now.getTime() - this.lastExpiry < interval) return;
    this.lastExpiry = now.getTime();
    const emergency = this.emergency;
    try {
      const result = await runExpiryPass(this.opts, now, this.clock, {
        emergency,
        recountAll: this.recountAll,
        ...(this.opts.retentionDefaultDays !== undefined && { retentionDefaultDays: this.opts.retentionDefaultDays }),
        ...(this.opts.retentionMaxDays !== undefined && { retentionMaxDays: this.opts.retentionMaxDays }),
      });
      this.recountAll = false;
      if (emergency) {
        // docs/retention.md: emergency expiry is logged per project with the count.
        for (const p of result.perProject) {
          this.opts.log.warn(
            { project_id: p.projectId, deleted_events: p.deleted, retention_days: p.retentionDays },
            "emergency expiry removed events",
          );
        }
      }
      this.opts.log.info(
        {
          deleted_events: result.deletedEvents,
          projects: result.projectsTouched,
          dedupe_pruned: result.dedupePruned,
          counters_pruned: result.countersPruned,
          emergency,
          audit_pruned: result.auditPruned,
        },
        "expiry pass done",
      );
    } catch (err) {
      this.recountAll = true;
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
      await this.checkDiskIfDue();
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
