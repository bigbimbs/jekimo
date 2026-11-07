import type { EventEnvelope } from "@jekimo/event-schema";
import { describe, expect, it } from "vitest";
import { issueTitle } from "../src/issue.js";

const base: EventEnvelope = {
  schema_version: 1,
  event_id: "01JBQ4Z3H8X9T2K7M5N6P8R9SV",
  timestamp: "2026-11-05T09:14:33.412Z",
  kind: "exception",
  severity: "error",
  message: "Database request failed",
  exception: { type: "DatabaseError", value: "connection terminated" },
};

describe("issueTitle", () => {
  it("titles issues from the exception or message", () => {
    expect(issueTitle(base)).toBe("DatabaseError: connection terminated");
    const { exception: _e, ...log } = base;
    expect(issueTitle({ ...log, kind: "log", message: "x".repeat(300) })).toHaveLength(256);
  });
});
