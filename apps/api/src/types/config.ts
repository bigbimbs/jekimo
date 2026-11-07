import type { LogLevel } from "../constants/index.js";

export interface ApiConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
  /** Trust X-Forwarded-For from a reverse proxy for the client address. */
  trustProxy: boolean;
  membersCanCreateProjects: boolean;
  sessionIdleDays: number;
  sessionMaxDays: number;
  retentionDefaultDays: number;
  retentionMaxDays: number;
  rateLimitPerMinute: number;
  /** Null: no quota. */
  quotaEventsPerDay: number | null;
  inviteExpiryDays: number;
  keyRotationGraceHours: number;
  /** Null: invitation and reset links are paths, not URLs. */
  publicUrl: string | null;
}
