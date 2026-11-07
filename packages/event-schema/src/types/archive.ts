import type { ArchiveFormat } from "../constants/archive.js";

export type ParsedArchiveKey =
  | { kind: "part"; projectId: string; day: string; part: number; format: ArchiveFormat }
  | { kind: "manifest"; projectId: string; day: string };

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
