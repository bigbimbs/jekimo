import type { EventEnvelope } from "@jekimo/event-schema";
import { describe, expect, it } from "vitest";
import { deriveFingerprint, fingerprintOf, inAppFrames, issueTitle, normalizeMessage } from "../src/fingerprint.js";

function exception(stacktrace: string, type = "DatabaseError", value = "connection terminated"): EventEnvelope {
  return {
    schema_version: 1,
    event_id: "01JBQ4Z3H8X9T2K7M5N6P8R9SV",
    timestamp: "2026-11-05T09:14:33.412Z",
    kind: "exception",
    severity: "error",
    message: "Database request failed",
    exception: { type, value, stacktrace },
  };
}

const STACK_V1 = [
  "DatabaseError: connection terminated",
  "    at chargeInvoice (/app/src/invoices/charge.ts:42:19)",
  "    at async handle (/app/src/routes/invoices.ts:10:5)",
  "    at Client.query (/app/node_modules/pg/lib/client.js:526:17)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  "    at async Promise.all (index 0)",
].join("\n");

describe("exception fingerprints", () => {
  it("keeps in-app frames and strips line and column numbers", () => {
    expect(inAppFrames(STACK_V1)).toEqual([
      "chargeInvoice (/app/src/invoices/charge.ts)",
      "async handle (/app/src/routes/invoices.ts)",
    ]);
    expect(inAppFrames("    at /app/src/main.ts:3:1")).toEqual(["/app/src/main.ts"]);
  });

  it("does not split an issue when a release moves lines or library frames change", () => {
    const moved = STACK_V1.replace("charge.ts:42:19", "charge.ts:57:3").replace("client.js:526:17", "client.js:600:1");
    const libraryChanged = STACK_V1.replace(
      "/app/node_modules/pg/lib/client.js",
      "/app/node_modules/pg/lib/connection.js",
    );
    expect(deriveFingerprint(exception(moved))).toBe(deriveFingerprint(exception(STACK_V1)));
    expect(deriveFingerprint(exception(libraryChanged))).toBe(deriveFingerprint(exception(STACK_V1)));
  });

  it("separates different types and different code paths", () => {
    const base = deriveFingerprint(exception(STACK_V1));
    expect(deriveFingerprint(exception(STACK_V1, "TimeoutError"))).not.toBe(base);
    expect(deriveFingerprint(exception(STACK_V1.replace("chargeInvoice", "refundInvoice")))).not.toBe(base);
  });

  it("falls back to the normalised value when there are no in-app frames", () => {
    const a = deriveFingerprint(exception("", "DatabaseError", "timeout after 5000ms"));
    const b = deriveFingerprint(exception("", "DatabaseError", "timeout after 3000ms"));
    expect(a).toBe(b);
  });

  it("is a SHA-256 hex digest within the 256-character limit", () => {
    expect(deriveFingerprint(exception(STACK_V1))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("message fingerprints", () => {
  it("replaces numbers, UUIDs, and hex strings with placeholders", () => {
    expect(normalizeMessage("user 42 failed after 3.5s on 6f1c2a9e-3b4d-4c5e-8f70-1a2b3c4d5e6f")).toBe(
      "user <num> failed after <num>s on <uuid>",
    );
    expect(normalizeMessage("commit 4bf92f3577b34da6 at 0xDEADBEEF")).toBe("commit <hex> at <hex>");
    expect(normalizeMessage("invoice inv_000123 retried")).toBe("invoice inv_<num> retried");
    expect(normalizeMessage("utf8 decode failed in v2")).toBe("utf8 decode failed in v2");
  });

  it("groups log messages that differ only by ids", () => {
    const log = (message: string): EventEnvelope =>
      ({ ...exception(""), kind: "log", severity: "info", message, exception: undefined }) as unknown as EventEnvelope;
    expect(deriveFingerprint(log("order 1001 shipped"))).toBe(deriveFingerprint(log("order 2002 shipped")));
    expect(deriveFingerprint(log("order 1001 shipped"))).not.toBe(deriveFingerprint(log("order 1001 cancelled")));
  });

  it("lets an explicit fingerprint win", () => {
    expect(fingerprintOf({ ...exception(STACK_V1), fingerprint: "DatabaseError:charge-invoice" })).toBe(
      "DatabaseError:charge-invoice",
    );
  });

  it("titles issues from the exception or message", () => {
    expect(issueTitle(exception(STACK_V1))).toBe("DatabaseError: connection terminated");
    expect(
      issueTitle({ ...exception(""), message: "x".repeat(300), exception: undefined } as unknown as EventEnvelope),
    ).toHaveLength(256);
  });
});
