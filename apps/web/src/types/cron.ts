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
  health: "pending" | "healthy" | "failing";
  nextExpectedAt: string;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  incidentOpen: boolean;
}
export interface CronRun {
  id: string;
  status: "started" | "ok" | "error" | "timeout" | "missed" | "cancelled";
  startedAt: string | null;
  finishedAt: string | null;
  expectedAt: string | null;
  deadlineAt: string | null;
}
export interface CronApi {
  listCronMonitors(projectId: string): Promise<CronMonitor[]>;
  createCronMonitor(projectId: string, input: CronMonitorInput): Promise<CronMonitor>;
  enableCronMonitor(projectId: string, id: string, enabled: boolean): Promise<void>;
  listCronRuns(projectId: string, id: string): Promise<CronRun[]>;
}
