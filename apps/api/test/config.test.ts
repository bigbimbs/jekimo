import { RETENTION } from "@jekimo/event-schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_API_CONFIG, loadApiConfig } from "../src/config.js";

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
  ])("rejects %o", (env, message) => {
    expect(() => loadApiConfig(env)).toThrow(message);
  });
});
