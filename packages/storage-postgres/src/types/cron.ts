import type { CronHealth, CronRunStatus } from "../constants/cron.js";
import type { ProjectAccess } from "./access.js";

export interface CronMonitorInput {
  name: string;
  expression: string;
  timezone: string;
  graceSeconds: number;
  maxRuntimeSeconds: number;
  failureThreshold: number;
  recoveryThreshold: number;
  channelId: string | null;
}
export interface CronMonitor extends CronMonitorInput {
  id: string;
  enabled: boolean;
  health: CronHealth;
  nextExpectedAt: Date;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  incidentOpen: boolean;
}
export interface CronRun {
  id: string;
  status: CronRunStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  expectedAt: Date | null;
  deadlineAt: Date | null;
}
export interface CronCheckIn {
  runId: string;
  status: "started" | "ok" | "error";
}
export interface CronRepository {
  list(access: ProjectAccess): Promise<CronMonitor[]>;
  create(access: ProjectAccess, input: CronMonitorInput, now: Date): Promise<CronMonitor | null>;
  setEnabled(access: ProjectAccess, id: string, enabled: boolean, now: Date): Promise<boolean>;
  runs(access: ProjectAccess, id: string): Promise<CronRun[] | null>;
  /** projectId is derived from a verified ingestion credential, never the request body. */
  checkIn(
    projectId: string,
    id: string,
    input: CronCheckIn,
    now: Date,
  ): Promise<CronRun | "not_found" | "disabled" | "rate_limited" | "conflict">;
  scan(now: Date): Promise<number>;
  prune(now: Date): Promise<void>;
}
