/**
 * API configuration from environment variables. Documented in
 * docs/configuration.md; safe placeholders live in .env.example.
 */

import { RETENTION } from "@jekimo/event-schema";

export interface ApiConfig {
  host: string;
  port: number;
  logLevel: string;
  /** Trust X-Forwarded-For from a reverse proxy for the client address. */
  trustProxy: boolean;
  membersCanCreateProjects: boolean;
  sessionIdleDays: number;
  sessionMaxDays: number;
  retentionDefaultDays: number;
  retentionMaxDays: number;
}

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
};

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false`);
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const d = DEFAULT_API_CONFIG;
  const retentionMaxDays = int(
    env,
    "JEKIMO_RETENTION_MAX_DAYS",
    d.retentionMaxDays,
    RETENTION.MIN_DAYS,
    RETENTION.MAX_DAYS,
  );
  const sessionMaxDays = int(env, "JEKIMO_SESSION_MAX_DAYS", d.sessionMaxDays, 1, 365);
  return {
    host: env.JEKIMO_API_HOST || d.host,
    port: int(env, "JEKIMO_API_PORT", d.port, 1, 65535),
    logLevel: env.JEKIMO_LOG_LEVEL || d.logLevel,
    trustProxy: bool(env, "JEKIMO_TRUST_PROXY", d.trustProxy),
    membersCanCreateProjects: bool(env, "JEKIMO_MEMBERS_CAN_CREATE_PROJECTS", d.membersCanCreateProjects),
    sessionIdleDays: int(env, "JEKIMO_SESSION_IDLE_DAYS", d.sessionIdleDays, 1, sessionMaxDays),
    sessionMaxDays,
    retentionDefaultDays: int(
      env,
      "JEKIMO_RETENTION_DEFAULT_DAYS",
      d.retentionDefaultDays,
      RETENTION.MIN_DAYS,
      retentionMaxDays,
    ),
    retentionMaxDays,
  };
}
