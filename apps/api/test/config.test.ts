import { RETENTION } from "@jekimo/event-schema";
import { describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/config.js";
import { DEFAULT_API_CONFIG } from "../src/constants/index.js";

describe("loadApiConfig", () => {
  it("uses the defaults when nothing is set", () => {
    expect(loadApiConfig({})).toEqual(DEFAULT_API_CONFIG);
    expect(DEFAULT_API_CONFIG).toMatchObject({
      host: "127.0.0.1",
      port: 8080,
      logLevel: "info",
      trustProxy: false,
      membersCanCreateProjects: true,
      sessionIdleDays: 14,
      sessionMaxDays: 30,
      retentionDefaultDays: RETENTION.DEFAULT_DAYS,
      retentionMaxDays: RETENTION.MAX_DAYS,
      rateLimitPerMinute: 1000,
      quotaEventsPerDay: null,
    });
  });

  it("treats empty values as unset", () => {
    expect(loadApiConfig({ JEKIMO_LOG_LEVEL: "", JEKIMO_API_PORT: "", JEKIMO_TRUST_PROXY: "" })).toEqual(
      DEFAULT_API_CONFIG,
    );
  });

  it("reads valid values", () => {
    expect(
      loadApiConfig({
        JEKIMO_API_HOST: "0.0.0.0",
        JEKIMO_API_PORT: "9090",
        JEKIMO_LOG_LEVEL: "debug",
        JEKIMO_TRUST_PROXY: "true",
        JEKIMO_MEMBERS_CAN_CREATE_PROJECTS: "0",
        JEKIMO_SESSION_IDLE_DAYS: "7",
        JEKIMO_SESSION_MAX_DAYS: "60",
        JEKIMO_RETENTION_DEFAULT_DAYS: "14",
        JEKIMO_RETENTION_MAX_DAYS: "60",
        JEKIMO_RATE_LIMIT_PER_MINUTE: "250",
        JEKIMO_QUOTA_EVENTS_PER_DAY: "50000",
        JEKIMO_INVITE_EXPIRY_DAYS: "3",
        JEKIMO_KEY_ROTATION_GRACE_HOURS: "0",
        JEKIMO_PUBLIC_URL: "https://jekimo.example.test/",
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 9090,
      logLevel: "debug",
      trustProxy: true,
      membersCanCreateProjects: false,
      sessionIdleDays: 7,
      sessionMaxDays: 60,
      retentionDefaultDays: 14,
      retentionMaxDays: 60,
      rateLimitPerMinute: 250,
      quotaEventsPerDay: 50000,
      inviteExpiryDays: 3,
      keyRotationGraceHours: 0,
      publicUrl: "https://jekimo.example.test",
    });
  });

  it.each(["fatal", "error", "warn", "info", "debug", "trace"])("accepts log level %s", (level) => {
    expect(loadApiConfig({ JEKIMO_LOG_LEVEL: level }).logLevel).toBe(level);
  });

  it.each([
    [{ JEKIMO_LOG_LEVEL: "verbose" }, "JEKIMO_LOG_LEVEL must be one of fatal, error, warn, info, debug, trace"],
    [{ JEKIMO_LOG_LEVEL: "INFO" }, "JEKIMO_LOG_LEVEL must be one of"],
    [{ JEKIMO_API_PORT: "0" }, "JEKIMO_API_PORT must be an integer from 1 to 65535"],
    [{ JEKIMO_API_PORT: "80.5" }, "JEKIMO_API_PORT must be an integer"],
    [{ JEKIMO_API_PORT: "http" }, "JEKIMO_API_PORT must be an integer"],
    [{ JEKIMO_TRUST_PROXY: "yes" }, "JEKIMO_TRUST_PROXY must be true or false"],
    [
      { JEKIMO_SESSION_MAX_DAYS: "5", JEKIMO_SESSION_IDLE_DAYS: "6" },
      "JEKIMO_SESSION_IDLE_DAYS must be an integer from 1 to 5",
    ],
    [
      { JEKIMO_RETENTION_MAX_DAYS: "30", JEKIMO_RETENTION_DEFAULT_DAYS: "31" },
      "JEKIMO_RETENTION_DEFAULT_DAYS must be an integer from 1 to 30",
    ],
    [{ JEKIMO_RETENTION_MAX_DAYS: String(RETENTION.MAX_DAYS + 1) }, "JEKIMO_RETENTION_MAX_DAYS must be an integer"],
    [{ JEKIMO_RATE_LIMIT_PER_MINUTE: "99" }, "JEKIMO_RATE_LIMIT_PER_MINUTE must be an integer from 100 to 1000000"],
    [{ JEKIMO_QUOTA_EVENTS_PER_DAY: "0" }, "JEKIMO_QUOTA_EVENTS_PER_DAY must be an integer from 1"],
    [{ JEKIMO_INVITE_EXPIRY_DAYS: "0" }, "JEKIMO_INVITE_EXPIRY_DAYS must be an integer from 1 to 90"],
    [{ JEKIMO_KEY_ROTATION_GRACE_HOURS: "721" }, "JEKIMO_KEY_ROTATION_GRACE_HOURS must be an integer from 0 to 720"],
    [{ JEKIMO_PUBLIC_URL: "jekimo.example.test" }, "JEKIMO_PUBLIC_URL must be an http or https URL"],
    [{ JEKIMO_PUBLIC_URL: "ftp://jekimo.example.test" }, "JEKIMO_PUBLIC_URL must be an http or https URL"],
    [{ JEKIMO_PUBLIC_URL: "https://jekimo.example.test/?a=1" }, "without credentials, query, or fragment"],
  ])("rejects %o", (env, message) => {
    expect(() => loadApiConfig(env)).toThrow(message);
  });
});
