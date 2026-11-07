// Server side of docs/ingestion-protocol.md, "Processing".

import { bearerToken } from "@jekimo/event-schema";
import {
  type IngestionKeyLookup,
  type IngestJob,
  type IngestLimits,
  type IngestUsage,
  QueueFullError,
  secondsUntilNextMinute,
  secondsUntilNextUtcDay,
} from "@jekimo/storage-postgres";
import type { FastifyBaseLogger } from "fastify";
import {
  DISK_FULL_RETRY_AFTER_SECONDS,
  QUEUE_FULL_RETRY_AFTER_SECONDS,
  RETRY_AFTER_SECONDS,
} from "../../constants/index.js";
import { IngestError } from "../../errors.js";
import { keyIdForLookup, verifyIngestionKey } from "../../keys.js";
import type { IngestAuthentication, IngestServiceDeps, ValidatedIngest } from "../../types/index.js";

const unauthorized = () => new IngestError("unauthorized", "missing, malformed, unknown, or revoked ingestion key");

function errorFields(err: unknown) {
  return { type: (err as Error).name, message: (err as Error).message };
}

export function rateLimited(limits: IngestLimits, now: Date): IngestError {
  return new IngestError(
    "rate_limited",
    `project exceeded ${limits.ratePerMinute} events per minute`,
    secondsUntilNextMinute(now),
  );
}

/** docs/retention.md, "Quotas": refused until midnight UTC. */
export function quotaExceeded(limits: IngestLimits, now: Date): IngestError {
  return new IngestError(
    "quota_exceeded",
    `project exceeded its quota of ${limits.eventsPerDay} events per day`,
    secondsUntilNextUtcDay(now),
  );
}

export class IngestService {
  constructor(private readonly deps: IngestServiceDeps) {}

  /**
   * Step 1 of "Processing": runs before the body is read. Malformed and
   * unknown keys take the same path: one lookup, one hash, one comparison.
   */
  async authenticate(authorization: string | undefined): Promise<IngestAuthentication> {
    const receivedAt = this.deps.clock();
    const token = bearerToken(authorization);
    const { keyId, wellFormed } = keyIdForLookup(token);
    const record = await this.deps.metadata.findIngestionKey(keyId);
    const matches = verifyIngestionKey(token, record);
    if (
      !wellFormed ||
      !record ||
      !matches ||
      record.revokedAt !== null ||
      (record.expiresAt !== null && record.expiresAt <= receivedAt)
    ) {
      throw unauthorized();
    }
    if (!this.deps.limits) return { record, receivedAt };
    const read = await this.deps.limits.read(record.projectId, receivedAt);
    if (!read) throw unauthorized();
    const limits: IngestLimits = {
      ratePerMinute: read.rateLimitPerMinute ?? this.deps.limitDefaults.ratePerMinute,
      eventsPerDay: read.eventsPerDay ?? this.deps.limitDefaults.eventsPerDay,
    };
    return { record, receivedAt, limits, usage: read };
  }

  /**
   * A full minute refuses before the body is read. A project over quota with
   * room in its minute is let through so its dropped events can be counted.
   */
  async admit(
    record: IngestionKeyLookup,
    receivedAt: Date,
    limits: IngestLimits | undefined,
    usage: IngestUsage | undefined,
  ): Promise<void> {
    if (record.projectDisabled) throw new IngestError("project_disabled", "project is disabled");
    if (this.deps.disk && (await this.deps.disk.status()).level === "full") {
      throw new IngestError(
        "unavailable",
        "the server is low on disk space; retry later",
        DISK_FULL_RETRY_AFTER_SECONDS,
      );
    }
    if (limits && usage && usage.minuteEvents >= limits.ratePerMinute) {
      const overQuota = limits.eventsPerDay !== null && usage.dayEvents >= limits.eventsPerDay;
      throw overQuota ? quotaExceeded(limits, receivedAt) : rateLimited(limits, receivedAt);
    }
  }

  /**
   * Counts the request's events against the project's limits. When the quota
   * is exceeded the events are added to the daily `dropped` counter, best
   * effort. Undefined when ingest is not limited.
   */
  async charge(projectId: string, receivedAt: Date, events: number, limits: IngestLimits, log: FastifyBaseLogger) {
    if (!this.deps.limits) return undefined;
    const charged = await this.deps.limits.charge(projectId, receivedAt, events, limits);
    if (charged.outcome === "quota_exceeded") {
      try {
        await this.deps.metadata.incrementDailyCounters(projectId, {
          day: receivedAt.toISOString().slice(0, 10),
          dropped: events,
        });
      } catch (err) {
        log.warn({ err: errorFields(err), project_id: projectId }, "dropped counter update failed");
      }
    }
    return charged;
  }

  /**
   * Step 7: one queue row per request, so either every accepted event is
   * queued or none is. Then the daily `rejected` counter (docs/retention.md,
   * "What is retained"): one statement, attempted once and never retried, so
   * it applies at most once. The events are already queued, so a failure
   * there is logged and the 202 stands: a retrying client would only add repeats.
   */
  async enqueue(
    projectId: string,
    keyId: string,
    receivedAt: Date,
    result: ValidatedIngest,
    log: FastifyBaseLogger,
  ): Promise<void> {
    if (result.accepted.length > 0) {
      const job: IngestJob = {
        project_id: projectId,
        key_id: keyId,
        received_at: receivedAt.toISOString(),
        events: result.accepted.map((a) => a.event),
      };
      // The protocol defines skew as received_at - sent_at; the validator
      // reports the client clock minus the server clock.
      if (result.skewMs !== undefined) job.skew_ms = -result.skewMs;
      try {
        await this.deps.queue.enqueue(job);
      } catch (err) {
        if (err instanceof QueueFullError) {
          log.warn({ project_id: projectId, max_depth: err.maxDepth }, "ingest queue full");
          throw new IngestError("unavailable", "the ingest queue is full; retry later", QUEUE_FULL_RETRY_AFTER_SECONDS);
        }
        log.error({ err: errorFields(err), project_id: projectId }, "enqueue failed");
        throw new IngestError("unavailable", "the server could not accept events; retry later", RETRY_AFTER_SECONDS);
      }
    }
    if (result.rejected.length > 0) {
      try {
        await this.deps.metadata.incrementDailyCounters(projectId, {
          day: receivedAt.toISOString().slice(0, 10),
          rejected: result.rejected.length,
        });
      } catch (err) {
        log.warn({ err: errorFields(err), project_id: projectId }, "rejected counter update failed");
      }
    }
  }
}
