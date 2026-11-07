import type { DailyCounterName } from "../constants/project-settings.js";

export interface ProjectRecord {
  id: string;
  name: string;
  retentionDays: number;
  sampleRate: number;
  disabled: boolean;
  createdAt: Date;
}

export interface ProjectRetention {
  projectId: string;
  retentionDays: number;
}

/** One project's counts for one UTC day. */
export interface DailyCounters {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  accepted: number;
  rejected: number;
  dropped: number;
  sampled: number;
}

export interface DailyCounterIncrement extends Partial<Record<DailyCounterName, number>> {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Makes the increment apply at most once per project, for example `job:<id>`. */
  idempotencyKey?: string;
}

/** Operator-configured redaction on top of DEFAULT_REDACTED_KEYS. */
export interface RedactionRules {
  /** Key names, stored normalized (lower-cased, without `-`, `_`, and spaces). */
  keys: string[];
  /** Regular expression sources matched against key names. */
  patterns: string[];
}
