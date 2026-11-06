/**
 * Cold-tier key layout and hot/cold retention split.
 * Normative text: docs/object-storage.md.
 */

import { RETENTION } from "./retention.js";

export const ARCHIVE_LAYOUT_VERSION = 1 as const;

/** Archive part formats recorded in a day manifest. */
export const ARCHIVE_FORMATS = ["ndjson.zst"] as const;
export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number];

/** Internal project identifiers must be safe to embed in object keys. */
export const SAFE_PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Calendar day in UTC as YYYY-MM-DD. */
export const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const HOT_DAYS = {
  /** Hot period for new projects when an object store is configured. */
  DEFAULT_WITH_OBJECT_STORE: 14,
  /** Total retention for new projects when an object store is configured. */
  RETENTION_DEFAULT_WITH_OBJECT_STORE: 90,
  MAX: 365,
} as const;

function assertProjectId(projectId: string): void {
  if (!SAFE_PROJECT_ID_PATTERN.test(projectId)) throw new RangeError("projectId is not a safe identifier");
}

function splitDay(day: string): [string, string, string] {
  const [, y, mo, d] = DAY_PATTERN.exec(day) ?? [];
  if (y === undefined || mo === undefined || d === undefined) throw new RangeError("day must be YYYY-MM-DD");
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) {
    throw new RangeError("day is not a valid calendar date");
  }
  return [y, mo, d];
}

/** Formats a Date as the UTC day it falls on. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `v1/projects/<project_id>/` — everything about one project lives under it. */
export function projectPrefix(projectId: string): string {
  assertProjectId(projectId);
  return `v${ARCHIVE_LAYOUT_VERSION}/projects/${projectId}/`;
}

/** `v1/projects/<project_id>/events/<YYYY>/<MM>/<DD>/` */
export function archiveDayPrefix(projectId: string, day: string): string {
  const [y, m, d] = splitDay(day);
  return `${projectPrefix(projectId)}events/${y}/${m}/${d}/`;
}

export function archivePartKey(
  projectId: string,
  day: string,
  part: number,
  format: ArchiveFormat = "ndjson.zst",
): string {
  if (!Number.isInteger(part) || part < 0 || part > 99999)
    throw new RangeError("part must be an integer from 0 to 99999");
  return `${archiveDayPrefix(projectId, day)}part-${String(part).padStart(5, "0")}.${format}`;
}

export function archiveManifestKey(projectId: string, day: string): string {
  return `${archiveDayPrefix(projectId, day)}manifest.json`;
}

export type ParsedArchiveKey =
  | { kind: "part"; projectId: string; day: string; part: number; format: ArchiveFormat }
  | { kind: "manifest"; projectId: string; day: string };

const ARCHIVE_KEY_PATTERN =
  /^v1\/projects\/([a-z0-9][a-z0-9_-]{0,63})\/events\/(\d{4})\/(\d{2})\/(\d{2})\/(?:part-(\d{5})\.(ndjson\.zst)|manifest\.json)$/;

/** Parses an archive key back into its parts, or returns null for anything else. Never throws. */
export function parseArchiveKey(key: string): ParsedArchiveKey | null {
  const [, projectId, y, mo, d, part, format] = ARCHIVE_KEY_PATTERN.exec(key) ?? [];
  if (projectId === undefined) return null;
  const day = `${y}-${mo}-${d}`;
  try {
    splitDay(day);
  } catch {
    return null;
  }
  if (part !== undefined) {
    return { kind: "part", projectId, day, part: Number(part), format: format as ArchiveFormat };
  }
  return { kind: "manifest", projectId, day };
}

export interface RetentionSplitInput {
  /** Total retention in days, hot plus cold. */
  retentionDays: number;
  /** Requested hot period; omitted means "use the default for the configuration". */
  hotDays?: number;
  objectStoreConfigured: boolean;
  maxRetentionDays?: number;
  maxHotDays?: number;
}

export type RetentionSplit =
  | { ok: true; hotDays: number; coldDays: number }
  | { ok: false; reason: "invalid_retention" | "invalid_hot_days" | "hot_exceeds_retention" | "cold_tier_unavailable" };

/**
 * Resolves a project's hot and cold periods. Without an object store the hot
 * period must equal the total; with one, the hot period defaults to
 * HOT_DAYS.DEFAULT_WITH_OBJECT_STORE capped by the total.
 */
export function splitRetention(input: RetentionSplitInput): RetentionSplit {
  const maxRetention = input.maxRetentionDays ?? RETENTION.MAX_DAYS;
  const maxHot = input.maxHotDays ?? HOT_DAYS.MAX;
  const { retentionDays } = input;
  if (!Number.isInteger(retentionDays) || retentionDays < RETENTION.MIN_DAYS || retentionDays > maxRetention) {
    return { ok: false, reason: "invalid_retention" };
  }

  if (!input.objectStoreConfigured) {
    if (input.hotDays !== undefined && input.hotDays !== retentionDays) {
      return { ok: false, reason: "cold_tier_unavailable" };
    }
    return { ok: true, hotDays: retentionDays, coldDays: 0 };
  }

  const hotDays = input.hotDays ?? Math.min(HOT_DAYS.DEFAULT_WITH_OBJECT_STORE, retentionDays);
  if (!Number.isInteger(hotDays) || hotDays < RETENTION.MIN_DAYS || hotDays > maxHot) {
    return { ok: false, reason: "invalid_hot_days" };
  }
  if (hotDays > retentionDays) return { ok: false, reason: "hot_exceeds_retention" };
  return { ok: true, hotDays, coldDays: retentionDays - hotDays };
}
