import { bearerToken } from "@jekimo/event-schema";
import type { CronMonitor, CronMonitorInput, ProjectAccess } from "@jekimo/storage-postgres";
import { nextCronDate } from "@jekimo/storage-postgres";
import { ApiError } from "../../errors.js";
import { keyIdForLookup, verifyIngestionKey } from "../../keys.js";
import type { CronServiceDeps } from "../../types/cron.js";

function invalid(message: string): never {
  throw new ApiError(400, "invalid_request", message);
}
function text(b: Record<string, unknown>, key: string, max: number): string {
  const v = b[key];
  if (typeof v !== "string" || !v.trim() || v.length > max) return invalid(`invalid ${key}`);
  return v.trim();
}
function number(b: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = b[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return invalid(`invalid ${key}`);
  return v;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    return invalid("invalid identifier");
  return value;
}
export class CronService {
  constructor(private readonly deps: CronServiceDeps) {}
  list(access: ProjectAccess) {
    return this.deps.repository.list(access);
  }
  async create(access: ProjectAccess, b: Record<string, unknown>) {
    const expression = text(b, "expression", 128);
    const timezone = text(b, "timezone", 100);
    const now = this.deps.clock();
    try {
      nextCronDate(expression, timezone, now);
    } catch {
      throw new ApiError(400, "invalid_cron_schedule", "use a valid five-field cron expression and timezone");
    }
    const input: CronMonitorInput = {
      name: text(b, "name", 100),
      expression,
      timezone,
      graceSeconds: number(b, "graceSeconds", 0, 86400),
      maxRuntimeSeconds: number(b, "maxRuntimeSeconds", 1, 604800),
      failureThreshold: number(b, "failureThreshold", 1, 100),
      recoveryThreshold: number(b, "recoveryThreshold", 1, 100),
      channelId: b.channelId === null ? null : id(b.channelId),
    };
    let monitor: CronMonitor | null;
    try {
      monitor = await this.deps.repository.create(access, input, now);
    } catch (error) {
      if (error instanceof RangeError)
        throw new ApiError(409, "cron_monitor_limit", "this project has reached its monitor limit");
      throw error;
    }
    if (!monitor) throw new ApiError(404, "not_found", "notification connection not found");
    return monitor;
  }
  async setEnabled(access: ProjectAccess, monitorId: string, b: Record<string, unknown>) {
    if (typeof b.enabled !== "boolean") return invalid("enabled must be a boolean");
    if (!(await this.deps.repository.setEnabled(access, id(monitorId), b.enabled, this.deps.clock())))
      throw new ApiError(404, "not_found", "monitor not found");
  }
  async runs(access: ProjectAccess, monitorId: string) {
    const runs = await this.deps.repository.runs(access, id(monitorId));
    if (!runs) throw new ApiError(404, "not_found", "monitor not found");
    return runs;
  }
  async authenticate(authorization: string | undefined): Promise<string> {
    const token = bearerToken(authorization);
    const lookup = keyIdForLookup(token);
    const record = await this.deps.metadata.findIngestionKey(lookup.keyId);
    const matches = verifyIngestionKey(token, record);
    const now = this.deps.clock();
    if (!lookup.wellFormed || !record || !matches || record.revokedAt || (record.expiresAt && record.expiresAt <= now))
      throw new ApiError(401, "unauthorized", "valid ingestion key required");
    if (record.projectDisabled) throw new ApiError(403, "project_disabled", "project disabled");
    if (this.deps.disk && (await this.deps.disk.status()).level === "full")
      throw new ApiError(503, "unavailable", "storage unavailable");
    return record.projectId;
  }
  async checkIn(projectId: string, monitorId: string, b: Record<string, unknown>) {
    if (Object.keys(b).some((k) => k !== "run_id" && k !== "status"))
      return invalid("only run_id and status are accepted");
    if (b.status !== "started" && b.status !== "ok" && b.status !== "error")
      return invalid("status must be started, ok or error");
    const result = await this.deps.repository.checkIn(
      projectId,
      id(monitorId),
      { runId: id(b.run_id), status: b.status },
      this.deps.clock(),
    );
    if (result === "not_found") throw new ApiError(404, "not_found", "monitor not found");
    if (result === "disabled") throw new ApiError(409, "cron_monitor_paused", "monitor is paused");
    if (result === "rate_limited") throw new ApiError(429, "rate_limited", "too many check-ins or concurrent runs", 60);
    if (result === "conflict") throw new ApiError(409, "cron_run_finished", "run already has a different final status");
    return result;
  }
}
