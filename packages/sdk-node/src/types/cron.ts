import type { Transport } from "./transport.js";

export interface CronMonitorOptions {
  baseUrl: string;
  ingestionKey: string;
  monitorId: string;
  maxQueueSize?: number;
  transport?: Transport;
  onError?: (message: string) => void;
}
export interface CronMonitorClient {
  readonly enabled: boolean;
  checkIn(status: "started" | "ok" | "error", runId?: string): string | undefined;
  withMonitor<T>(job: () => T | Promise<T>): Promise<T>;
  flush(timeoutMs?: number): Promise<boolean>;
  close(timeoutMs?: number): Promise<boolean>;
}
