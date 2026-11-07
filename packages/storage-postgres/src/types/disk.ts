import type { DiskLevel, DiskThresholds } from "@jekimo/event-schema";

/** Resolves to the percentage of free space, 0 to 100. */
export type DiskProbe = () => Promise<number>;

export interface DiskConfig {
  thresholds: DiskThresholds;
  /** For statfs; ignored when budgetBytes is set. */
  path: string;
  /** When set, free space is measured against this database size budget. */
  budgetBytes: number | null;
}

export interface DiskStatus {
  level: DiskLevel;
  /** Null when the probe failed; the level is then `full`. */
  freePercent: number | null;
  checkedAt: Date;
}

export interface DiskMonitorOptions {
  probe: DiskProbe;
  thresholds?: DiskThresholds;
  /** Default 5000. */
  cacheMs?: number;
  /** Default 2000; a slower probe counts as failed. */
  timeoutMs?: number;
  clock?: () => Date;
  onError?: (err: { type: string; message: string }) => void;
}
