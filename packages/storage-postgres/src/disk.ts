/**
 * Free space on the database volume (docs/retention.md, "Disk safety").
 * `statfsDiskProbe` needs a path on that volume; `databaseBudgetDiskProbe` is
 * for PostgreSQL whose disk this process cannot see.
 */

import { statfs } from "node:fs/promises";
import { DISK_THRESHOLDS, type DiskThresholds, diskLevel } from "@jekimo/event-schema";
import { DEFAULT_DISK_CONFIG } from "./constants/disk.js";
import type { DiskConfig, DiskMonitorOptions, DiskProbe, DiskStatus } from "./types/disk.js";
import type { Pool } from "./types/pool.js";

export function statfsDiskProbe(path: string): DiskProbe {
  return async () => {
    const s = await statfs(path);
    if (!(s.blocks > 0)) throw new Error("filesystem reports no blocks");
    // bavail, not bfree: blocks reserved for root are not usable by PostgreSQL.
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

function percent(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${name} must be a number from 0 to 100`);
  return n;
}

/** Throws an Error naming the first invalid JEKIMO_DISK_* variable. */
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

export function diskProbeFor(config: DiskConfig, pool: Pool): DiskProbe {
  return config.budgetBytes === null ? statfsDiskProbe(config.path) : databaseBudgetDiskProbe(pool, config.budgetBytes);
}

/**
 * Caches readings and fails closed: a probe that throws or times out reads as
 * `full` (docs/retention.md: ingestion MUST fail closed when free space is unknown).
 */
export class DiskMonitor {
  private last: DiskStatus | undefined;
  private pending: Promise<DiskStatus> | undefined;
  private readonly clock: () => Date;

  constructor(private readonly opts: DiskMonitorOptions) {
    this.clock = opts.clock ?? (() => new Date());
  }

  /** Never throws. */
  status(): Promise<DiskStatus> {
    const now = this.clock();
    if (this.last && now.getTime() - this.last.checkedAt.getTime() < (this.opts.cacheMs ?? 5000)) {
      return Promise.resolve(this.last);
    }
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
    const status: DiskStatus = {
      level: diskLevel(freePercent ?? Number.NaN, thresholds),
      freePercent,
      checkedAt: this.clock(),
    };
    this.last = status;
    return status;
  }
}
