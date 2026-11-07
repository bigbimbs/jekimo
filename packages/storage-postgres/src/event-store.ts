// docs/architecture.md, "Storage engines": appends are idempotent on
// (project_id, event_id) without relying on an insert failing; every operation
// takes project_id; no metadata table is touched here, so no transaction spans
// the two stores.

import { EVENT_KINDS, type EventEnvelope, SEVERITIES, type Severity, utcDay } from "@jekimo/event-schema";
import { MESSAGE_VECTOR } from "./constants/sql.js";
import { withTransaction } from "./pool.js";
import type {
  AppendEvent,
  EventPage,
  EventQuery,
  EventStore,
  EventStoreCapabilities,
  FingerprintSummary,
  StoredEvent,
} from "./types/event-store.js";
import type { Pool } from "./types/pool.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PARTITION_NAME = /^events_(\d{4})(\d{2})(\d{2})$/;
/** PostgreSQL: no partition of relation found for row. */
const NO_PARTITION = "23514";

/**
 * The words of a text search: runs of letters and digits, lowercased. The
 * same rule splits messages, so "db.internal" and "charge-invoice" each match
 * a search for either half.
 */
export function searchWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function partitionName(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError("day must be YYYY-MM-DD");
  return `events_${day.replaceAll("-", "")}`;
}

/** UTC days from `from`, `count` days long. */
export function daysFrom(from: Date, count: number): string[] {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Array.from({ length: count }, (_, i) => utcDay(new Date(start + i * DAY_MS)));
}

interface EventRow {
  project_id: string;
  event_id: string;
  received_at: Date;
  key_id: string;
  skew_ms: string | null;
  schema_version: number;
  timestamp: string;
  kind: EventEnvelope["kind"];
  severity: Severity;
  message: string;
  service: string | null;
  environment: string | null;
  release: string | null;
  fingerprint: string;
  exception_type: string | null;
  exception_value: string | null;
  exception_stacktrace: string | null;
  sdk_name: string | null;
  sdk_version: string | null;
  context: Record<string, string> | null;
  attributes: EventEnvelope["attributes"] | null;
}

function toRow(projectId: string, e: AppendEvent): Record<string, unknown> {
  const ev = e.event;
  return {
    project_id: projectId,
    event_id: ev.event_id,
    received_at: e.receivedAt.toISOString(),
    key_id: e.keyId,
    skew_ms: e.skewMs ?? null,
    schema_version: ev.schema_version,
    timestamp: ev.timestamp,
    kind: ev.kind,
    severity: ev.severity,
    message: ev.message,
    service: ev.service ?? null,
    environment: ev.environment ?? null,
    release: ev.release ?? null,
    fingerprint: ev.fingerprint,
    exception_type: ev.exception?.type ?? null,
    exception_value: ev.exception?.value ?? null,
    exception_stacktrace: ev.exception?.stacktrace ?? null,
    sdk_name: ev.sdk?.name ?? null,
    sdk_version: ev.sdk?.version ?? null,
    context: ev.context ?? null,
    attributes: ev.attributes ?? null,
  };
}

function fromRow(r: EventRow): StoredEvent {
  const event: StoredEvent["event"] = {
    schema_version: 1,
    event_id: r.event_id,
    project_id: r.project_id,
    timestamp: r.timestamp,
    kind: r.kind,
    severity: r.severity,
    message: r.message,
    fingerprint: r.fingerprint,
  };
  if (r.service !== null) event.service = r.service;
  if (r.environment !== null) event.environment = r.environment;
  if (r.release !== null) event.release = r.release;
  if (r.exception_type !== null) {
    event.exception = { type: r.exception_type };
    if (r.exception_value !== null) event.exception.value = r.exception_value;
    if (r.exception_stacktrace !== null) event.exception.stacktrace = r.exception_stacktrace;
  }
  if (r.sdk_name !== null && r.sdk_version !== null) event.sdk = { name: r.sdk_name, version: r.sdk_version };
  if (r.context !== null) event.context = r.context;
  if (r.attributes !== null && r.attributes !== undefined) event.attributes = r.attributes;
  const stored: StoredEvent = { receivedAt: r.received_at, keyId: r.key_id, event };
  if (r.skew_ms !== null) stored.skewMs = Number(r.skew_ms);
  return stored;
}

export function encodeCursor(receivedAt: Date, eventId: string): string {
  return Buffer.from(JSON.stringify([receivedAt.toISOString(), eventId])).toString("base64url");
}

/** Returns null for anything that is not a cursor this store produced. */
export function decodeCursor(cursor: string): { receivedAt: Date; eventId: string } | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [at, id] = value;
    if (typeof at !== "string" || typeof id !== "string") return null;
    const receivedAt = new Date(at);
    if (Number.isNaN(receivedAt.getTime())) return null;
    return { receivedAt, eventId: id };
  } catch {
    return null;
  }
}

const INSERT_COLUMNS = `project_id text, event_id text, received_at timestamptz, key_id text, skew_ms bigint,
  schema_version smallint, "timestamp" text, kind text, severity text, message text, service text,
  environment text, release text, fingerprint text, exception_type text, exception_value text,
  exception_stacktrace text, sdk_name text, sdk_version text, context jsonb, attributes jsonb`;

const COLUMN_LIST = `project_id, event_id, received_at, key_id, skew_ms, schema_version, "timestamp", kind,
  severity, message, service, environment, release, fingerprint, exception_type, exception_value,
  exception_stacktrace, sdk_name, sdk_version, context, attributes`;

export class PostgresEventStore implements EventStore {
  readonly capabilities: EventStoreCapabilities = { textSearch: true };
  /** Days known to have a partition, so appends do not ask every time. */
  private readonly preparedDays = new Set<string>();

  constructor(private readonly pool: Pool) {}

  async prepareDays(days: string[]): Promise<void> {
    for (const day of new Set(days)) {
      if (this.preparedDays.has(day)) continue;
      partitionName(day); // validates the format
      await this.pool.query("SELECT ensure_event_partition($1::date)", [day]);
      this.preparedDays.add(day);
    }
  }

  async appendEvents(projectId: string, events: AppendEvent[]): Promise<{ inserted: string[] }> {
    if (events.length === 0) return { inserted: [] };
    for (const e of events) {
      if (e.event.project_id !== projectId) throw new RangeError("event project_id does not match the append scope");
    }
    const days = events.map((e) => utcDay(e.receivedAt));
    await this.prepareDays(days);
    try {
      return await this.insert(projectId, events);
    } catch (err) {
      if ((err as { code?: string }).code !== NO_PARTITION) throw err;
      // Another process dropped a cached day: prepare it again and retry once.
      for (const d of days) this.preparedDays.delete(d);
      await this.prepareDays(days);
      return this.insert(projectId, events);
    }
  }

  private insert(projectId: string, events: AppendEvent[]): Promise<{ inserted: string[] }> {
    return withTransaction(this.pool, async (client) => {
      const fresh = await client.query<{ event_id: string }>(
        `INSERT INTO event_ids (project_id, event_id, received_at)
         SELECT $1, id, at FROM unnest($2::text[], $3::timestamptz[]) AS t(id, at)
         ON CONFLICT DO NOTHING
         RETURNING event_id`,
        [projectId, events.map((e) => e.event.event_id), events.map((e) => e.receivedAt.toISOString())],
      );
      const newIds = new Set(fresh.rows.map((r) => r.event_id));
      const rows = events.filter((e) => newIds.has(e.event.event_id)).map((e) => toRow(projectId, e));
      if (rows.length > 0) {
        await client.query(
          `INSERT INTO events (${COLUMN_LIST})
           SELECT ${COLUMN_LIST} FROM jsonb_to_recordset($1::jsonb) AS r(${INSERT_COLUMNS})
           ON CONFLICT DO NOTHING`,
          [JSON.stringify(rows)],
        );
      }
      return { inserted: events.map((e) => e.event.event_id).filter((id) => newIds.has(id)) };
    });
  }

  async queryEvents(projectId: string, query: EventQuery): Promise<EventPage> {
    const params: unknown[] = [projectId, query.from.toISOString(), query.to.toISOString()];
    let where = "project_id = $1 AND received_at >= $2 AND received_at < $3";
    const add = (value: unknown, clause: (n: string) => string) => {
      params.push(value);
      where += ` AND ${clause(`$${params.length}`)}`;
    };
    if (query.severities && query.severities.length > 0) {
      add(
        query.severities.filter((s) => (SEVERITIES as readonly string[]).includes(s)),
        (n) => `severity = ANY(${n}::text[])`,
      );
    }
    if (query.kinds && query.kinds.length > 0) {
      add(
        query.kinds.filter((k) => (EVENT_KINDS as readonly string[]).includes(k)),
        (n) => `kind = ANY(${n}::text[])`,
      );
    }
    if (query.environment !== undefined) add(query.environment, (n) => `environment = ${n}`);
    if (query.release !== undefined) add(query.release, (n) => `release = ${n}`);
    if (query.fingerprint !== undefined) add(query.fingerprint, (n) => `fingerprint = ${n}`);
    if (query.text !== undefined) {
      const words = searchWords(query.text);
      if (words.length === 0) throw new RangeError("text has no words to search for");
      add(words.join(" "), (n) => `${MESSAGE_VECTOR} @@ plainto_tsquery('simple', ${n})`);
    }
    if (query.cursor !== undefined) {
      const c = decodeCursor(query.cursor);
      if (c === null) throw new RangeError("invalid cursor");
      params.push(c.receivedAt.toISOString(), c.eventId);
      where += ` AND (received_at, event_id) < ($${params.length - 1}::timestamptz, $${params.length})`;
    }
    params.push(query.limit + 1);
    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${COLUMN_LIST} FROM events WHERE ${where}
       ORDER BY received_at DESC, event_id DESC LIMIT $${params.length}`,
      params,
    );
    const page: EventPage = { events: rows.slice(0, query.limit).map(fromRow) };
    const last = page.events.at(-1);
    if (rows.length > query.limit && last) {
      page.nextCursor = encodeCursor(last.receivedAt, last.event.event_id);
    }
    return page;
  }

  async getEvent(projectId: string, eventId: string): Promise<StoredEvent | null> {
    // Served by events_project_event_received_key, one probe per day partition.
    // Earliest first: past the 7-day deduplication window a retry can store
    // the same event_id again, and the first copy is the original.
    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${COLUMN_LIST} FROM events WHERE project_id = $1 AND event_id = $2
       ORDER BY received_at LIMIT 1`,
      [projectId, eventId],
    );
    const row = rows[0];
    return row ? fromRow(row) : null;
  }

  async summarizeFingerprints(projectId: string, fingerprints?: string[]): Promise<FingerprintSummary[]> {
    const params: unknown[] = [projectId];
    let where = "project_id = $1";
    if (fingerprints !== undefined) {
      if (fingerprints.length === 0) return [];
      params.push(fingerprints);
      where += " AND fingerprint = ANY($2::text[])";
    }
    const { rows } = await this.pool.query<{ fingerprint: string; n: string; first_seen: Date; last_seen: Date }>(
      `SELECT fingerprint, count(*) AS n, min(received_at) AS first_seen, max(received_at) AS last_seen
       FROM events WHERE ${where} GROUP BY fingerprint`,
      params,
    );
    return rows.map((r) => ({
      fingerprint: r.fingerprint,
      eventCount: Number(r.n),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    }));
  }

  /**
   * docs/retention.md, "Expiry mechanics". Day partitions are shared by every
   * project, so a project's day is removed in one of two ways:
   *
   * - If no other project has rows in a past day's partition, the partition
   *   is detached in one transaction and dropped in a later one. Queries stop
   *   seeing the day the moment the detach commits.
   * - Otherwise the project's rows are deleted in a single transaction, which
   *   PostgreSQL applies all at once or, if interrupted, not at all.
   *
   * Either way an interrupted run leaves the whole day visible or none of it.
   * A partition detached by a run that died before dropping it is dropped by
   * the next call for that day (listDays still reports it).
   */
  async expireDay(projectId: string, day: string): Promise<{ deleted: number }> {
    const part = partitionName(day);
    const past = day < utcDay(new Date());
    // The partition name is validated by partitionName and quoted below.
    const outcome = await withTransaction(this.pool, async (client) => {
      const state = await client.query<{ attached: boolean }>(
        "SELECT relispartition AS attached FROM pg_class WHERE oid = to_regclass($1)",
        [part],
      );
      const found = state.rows[0];
      if (!found) return { deleted: 0 };
      if (!found.attached) return "detached" as const;
      // Blocks appends and other expiry runs on this day, not reads.
      await client.query(`LOCK TABLE "${part}" IN SHARE ROW EXCLUSIVE MODE`);
      const range = await client.query<{ lo: string | null; hi: string | null }>(
        `SELECT (SELECT project_id FROM "${part}" ORDER BY project_id LIMIT 1) AS lo,
                (SELECT project_id FROM "${part}" ORDER BY project_id DESC LIMIT 1) AS hi`,
      );
      const lo = range.rows[0]?.lo ?? null;
      const hi = range.rows[0]?.hi ?? null;
      const onlyThisProject = lo === null || (lo === projectId && hi === projectId);
      if (past && onlyThisProject) {
        await client.query(`ALTER TABLE events DETACH PARTITION "${part}"`);
        return "detached" as const;
      }
      const res = await client.query(`DELETE FROM "${part}" WHERE project_id = $1`, [projectId]);
      return { deleted: res.rowCount ?? 0 };
    });
    if (outcome !== "detached") return outcome;
    this.preparedDays.delete(day);
    return this.dropDetached(projectId, part);
  }

  /**
   * Drops a detached day partition. It is only ever detached while it holds
   * one project's rows; if those belong to another project, that project's
   * own expiry run drops it, so its deleted count still reaches the caller.
   */
  private dropDetached(projectId: string, part: string): Promise<{ deleted: number }> {
    return withTransaction(this.pool, async (client) => {
      await client.query(`LOCK TABLE "${part}" IN ACCESS EXCLUSIVE MODE`);
      const counts = await client.query<{ mine: string; others: string }>(
        `SELECT count(*) FILTER (WHERE project_id = $1) AS mine,
                count(*) FILTER (WHERE project_id <> $1) AS others
         FROM "${part}"`,
        [projectId],
      );
      if (Number(counts.rows[0]?.others ?? 0) > 0) return { deleted: 0 };
      await client.query(`DROP TABLE "${part}"`);
      return { deleted: Number(counts.rows[0]?.mine ?? 0) };
    });
  }

  archiveDay(_projectId: string, _day: string): Promise<never> {
    return Promise.reject(
      new Error("archiveDay is not implemented: object storage is Phase 2 (docs/object-storage.md)"),
    );
  }

  async listDays(): Promise<string[]> {
    // Attached partitions, plus any left detached by an interrupted expiry.
    const { rows } = await this.pool.query<{ name: string }>(
      `SELECT relname AS name FROM pg_class
       WHERE relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'events'::regclass)
         AND relkind = 'r' AND relname ~ '^events_[0-9]{8}$'`,
    );
    return rows
      .map((r) => PARTITION_NAME.exec(r.name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `${m[1]}-${m[2]}-${m[3]}`)
      .sort();
  }

  async pruneDedupe(before: Date): Promise<number> {
    const res = await this.pool.query("DELETE FROM event_ids WHERE received_at < $1", [before.toISOString()]);
    return res.rowCount ?? 0;
  }
}
