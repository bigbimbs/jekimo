/**
 * Free space on the database volume (docs/retention.md, "Disk safety").
 *
 * Two probes:
 *
 * - `statfsDiskProbe(path)` reads the filesystem that holds `path`. Use it
 *   when this process can see the PostgreSQL data directory, or a path on
 *   the same filesystem: on one VPS, mount the database volume read-only.
 * - `databaseBudgetDiskProbe(pool, bytes)` compares the size of the database
 *   with a budget the operator sets. Use it when PostgreSQL is remote or
 *   managed and its disk cannot be seen from here.
 *
 * DiskMonitor caches the probe for a few seconds and fails closed: when the
 * probe throws or times out the level is `full` (docs/retention.md, "Ingestion
 * MUST fail closed when it cannot determine free space").
 */

import { statfs } from "node:fs/promises";
import { DISK_THRESHOLDS, type DiskLevel, type DiskThresholds, diskLevel } from "@jekimo/event-schema";
import type { Pool } from "./pool.js";

/** Resolves to the percentage of free space, 0 to 100. */
export type DiskProbe = () => Promise<number>;

export function statfsDiskProbe(path: string): DiskProbe {
  return async () => {
    const s = await statfs(path);
    if (!(s.blocks > 0)) throw new Error("filesystem reports no blocks");
    // bavail: blocks available to unprivileged users, as df reports them.
    return (Number(s.bavail) / Number(s.blocks)) * 100;
  };
}

export function databaseBudgetDiskProbe(pool: Pool, budgetBytes: number): DiskProbe {
  return async () => {
    const { rows } = await pool.query<{ size: string }>("SELECT pg_database_size(current_database()) AS size");
    const size = Number(rows[0]?.size);
    if (!Number.isFinite(size)) throw new Error("database size is unknown");
    return Math.max(0, ((budgetBytes - size) / budgetBytes) * 100);
  };
}

export interface DiskConfig {
  thresholds: DiskThresholds;
  /** Path for statfsDiskProbe. Ignored when budgetBytes is set. */
  path: string;
  /** When set, the database-size probe is used instead of statfs. */
  budgetBytes: number | null;
}

export const DEFAULT_DISK_CONFIG: DiskConfig = { thresholds: DISK_THRESHOLDS, path: "/", budgetBytes: null };

function percent(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${name} must be a number from 0 to 100`);
  return n;
}

/**
 * Reads JEKIMO_DISK_WARN_PERCENT, JEKIMO_DISK_CRITICAL_PERCENT,
 * JEKIMO_DISK_FULL_PERCENT, JEKIMO_DISK_PATH, and JEKIMO_DISK_BUDGET_BYTES.
 * Throws an Error naming the first invalid variable.
 */
export function diskConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DiskConfig {
  const d = DEFAULT_DISK_CONFIG;
  const thresholds: DiskThresholds = {
    WARN_PERCENT: percent(env, "JEKIMO_DISK_WARN_PERCENT", d.thresholds.WARN_PERCENT),
    CRITICAL_PERCENT: percent(env, "JEKIMO_DISK_CRITICAL_PERCENT", d.thresholds.CRITICAL_PERCENT),
    FULL_PERCENT: percent(env, "JEKIMO_DISK_FULL_PERCENT", d.thresholds.FULL_PERCENT),
  };
  if (thresholds.WARN_PERCENT < thresholds.CRITICAL_PERCENT) {
    throw new Error("JEKIMO_DISK_WARN_PERCENT must be at least JEKIMO_DISK_CRITICAL_PERCENT");
  }
  if (thresholds.CRITICAL_PERCENT < thresholds.FULL_PERCENT) {
    throw new Error("JEKIMO_DISK_CRITICAL_PERCENT must be at least JEKIMO_DISK_FULL_PERCENT");
  }
  let budgetBytes: number | null = d.budgetBytes;
  const rawBudget = env.JEKIMO_DISK_BUDGET_BYTES;
  if (rawBudget !== undefined && rawBudget !== "") {
    budgetBytes = Number(rawBudget);
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) {
      throw new Error("JEKIMO_DISK_BUDGET_BYTES must be a positive integer");
    }
  }
  return { thresholds, path: env.JEKIMO_DISK_PATH || d.path, budgetBytes };
}

/** The probe a DiskConfig describes. */
export function diskProbeFor(config: DiskConfig, pool: Pool): DiskProbe {
  return config.budgetBytes === null ? statfsDiskProbe(config.path) : databaseBudgetDiskProbe(pool, config.budgetBytes);
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
  /** How long a reading is reused. Default 5 seconds. */
  cacheMs?: number;
  /** A probe slower than this counts as a failure. Default 2 seconds. */
  timeoutMs?: number;
  clock?: () => Date;
  /** Called with the error type and message when the probe fails. */
  onError?: (err: { type: string; message: string }) => void;
}

export class DiskMonitor {
  private last: DiskStatus | undefined;
  private pending: Promise<DiskStatus> | undefined;
  private readonly clock: () => Date;

  constructor(private readonly opts: DiskMonitorOptions) {
    this.clock = opts.clock ?? (() => new Date());
  }

  /** A cached reading when fresh enough, otherwise a new one. Never throws. */
  status(): Promise<DiskStatus> {
    const now = this.clock();
    if (this.last && now.getTime() - this.last.checkedAt.getTime() < (this.opts.cacheMs ?? 5000)) {
      return Promise.resolve(this.last);
    }
    // Concurrent callers share one probe.
    this.pending ??= this.measure().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async measure(): Promise<DiskStatus> {
    const thresholds = this.opts.thresholds ?? DISK_THRESHOLDS;
    let freePercent: number | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("disk probe timed out")), this.opts.timeoutMs ?? 2000);
      });
      const value = await Promise.race([this.opts.probe(), timeout]);
      if (!Number.isFinite(value)) throw new Error("disk probe returned no number");
      freePercent = Math.min(100, Math.max(0, value));
    } catch (err) {
      const e = err as Error;
      this.opts.onError?.({ type: e?.name ?? "Error", message: e?.message ?? String(err) });
    } finally {
      clearTimeout(timer);
    }
    // diskLevel treats NaN as full: fail closed.
    const status: DiskStatus = {
      level: diskLevel(freePercent ?? Number.NaN, thresholds),
      freePercent,
      checkedAt: this.clock(),
    };
    this.last = status;
    return status;
  }
}
