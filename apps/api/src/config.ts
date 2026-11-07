// Documented in docs/configuration.md; safe placeholders live in .env.example.

import { RETENTION } from "@jekimo/event-schema";
import { INGEST_LIMIT_BOUNDS } from "@jekimo/storage-postgres";
import { DEFAULT_API_CONFIG, LOG_LEVELS, type LogLevel } from "./constants/index.js";
import type { ApiConfig } from "./types/index.js";

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

function logLevel(env: NodeJS.ProcessEnv, fallback: LogLevel): LogLevel {
  const raw = env.JEKIMO_LOG_LEVEL;
  if (raw === undefined || raw === "") return fallback;
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  throw new Error(`JEKIMO_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
}

function publicUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.JEKIMO_PUBLIC_URL;
  if (raw === undefined || raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("JEKIMO_PUBLIC_URL must be an http or https URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search !== "" || url.hash !== "" || url.username)
    throw new Error("JEKIMO_PUBLIC_URL must be an http or https URL without credentials, query, or fragment");
  return url.toString().replace(/\/+$/, "");
}

/** Throws an Error naming the first invalid variable. */
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
    logLevel: logLevel(env, d.logLevel),
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
    rateLimitPerMinute: int(
      env,
      "JEKIMO_RATE_LIMIT_PER_MINUTE",
      d.rateLimitPerMinute,
      INGEST_LIMIT_BOUNDS.MIN_PER_MINUTE,
      INGEST_LIMIT_BOUNDS.MAX_PER_MINUTE,
    ),
    quotaEventsPerDay:
      env.JEKIMO_QUOTA_EVENTS_PER_DAY === undefined || env.JEKIMO_QUOTA_EVENTS_PER_DAY === ""
        ? d.quotaEventsPerDay
        : int(env, "JEKIMO_QUOTA_EVENTS_PER_DAY", 0, INGEST_LIMIT_BOUNDS.MIN_PER_DAY, INGEST_LIMIT_BOUNDS.MAX_PER_DAY),
    inviteExpiryDays: int(env, "JEKIMO_INVITE_EXPIRY_DAYS", d.inviteExpiryDays, 1, 90),
    keyRotationGraceHours: int(env, "JEKIMO_KEY_ROTATION_GRACE_HOURS", d.keyRotationGraceHours, 0, 720),
    publicUrl: publicUrl(env),
  };
}
