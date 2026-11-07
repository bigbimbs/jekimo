import { RETENTION } from "@jekimo/event-schema";
import { DEFAULT_RATE_LIMIT_PER_MINUTE } from "@jekimo/storage-postgres";
import type { ApiConfig } from "../types/index.js";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_API_CONFIG: ApiConfig = {
  host: "127.0.0.1",
  port: 8080,
  logLevel: "info",
  trustProxy: false,
  membersCanCreateProjects: true,
  sessionIdleDays: 14,
  sessionMaxDays: 30,
  retentionDefaultDays: RETENTION.DEFAULT_DAYS,
  retentionMaxDays: RETENTION.MAX_DAYS,
  rateLimitPerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
  quotaEventsPerDay: null,
  inviteExpiryDays: 7,
  keyRotationGraceHours: 24,
  publicUrl: null,
};
