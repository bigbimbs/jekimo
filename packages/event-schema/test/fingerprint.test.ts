import { describe, expect, it } from "vitest";
import { deriveFingerprint, type EventEnvelope, LIMITS, normalizeMessage, stackFrames } from "../src/index.js";

function exception(stacktrace: string | undefined, type = "DatabaseError", value = "connection terminated") {
  return {
    kind: "exception",
    message: "Database request failed",
    exception: { type, value, ...(stacktrace !== undefined && { stacktrace }) },
  } satisfies Pick<EventEnvelope, "kind" | "message" | "exception">;
}

function log(message: string) {
  return { kind: "log", message } satisfies Pick<EventEnvelope, "kind" | "message">;
}

const STACK = [
  "DatabaseError: connection terminated",
  "    at chargeInvoice (/app/src/invoices/charge.ts:42:19)",
  "    at async handle (/app/src/routes/invoices.ts:10:5)",
  "    at Client.query (/app/node_modules/pg/lib/client.js:526:17)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  "    at async Promise.all (index 0)",
].join("\n");

describe("stackFrames", () => {
  it("strips line and column numbers and marks in-app frames", () => {
    expect(stackFrames(STACK)).toEqual([
      { frame: "chargeInvoice (/app/src/invoices/charge.ts)", inApp: true },
      { frame: "async handle (/app/src/routes/invoices.ts)", inApp: true },
      { frame: "Client.query (/app/node_modules/pg/lib/client.js)", inApp: false },
      { frame: "process.processTicksAndRejections (node:internal/process/task_queues)", inApp: false },
      { frame: "async Promise.all (index 0)", inApp: false },
    ]);
    expect(stackFrames("    at /app/src/main.ts:3:1")).toEqual([{ frame: "/app/src/main.ts", inApp: true }]);
  });
});

describe("deriveFingerprint", () => {
  it("returns an explicit fingerprint unchanged", () => {
    expect(deriveFingerprint({ ...exception(STACK), fingerprint: "DatabaseError:charge-invoice" })).toBe(
      "DatabaseError:charge-invoice",
    );
    expect(deriveFingerprint({ ...log("order 1 shipped"), fingerprint: "orders" })).toBe("orders");
  });

  it("ignores line and column numbers", () => {
    const moved = STACK.replace("charge.ts:42:19", "charge.ts:57:3").replace("invoices.ts:10:5", "invoices.ts:11:9");
    expect(deriveFingerprint(exception(moved))).toBe(deriveFingerprint(exception(STACK)));
  });

  it("separates different exception types with the same frames", () => {
    expect(deriveFingerprint(exception(STACK, "TimeoutError"))).not.toBe(deriveFingerprint(exception(STACK)));
  });

  it("separates different in-app code paths", () => {
    const other = STACK.replace("chargeInvoice", "refundInvoice");
    expect(deriveFingerprint(exception(other))).not.toBe(deriveFingerprint(exception(STACK)));
  });

  it("ignores node_modules and node: frames", () => {
    const libraryChanged = STACK.replace("/app/node_modules/pg/lib/client.js", "/app/node_modules/pg/lib/pool.js")
      .replace("node:internal/process/task_queues", "node:internal/timers")
      .replace("index 0", "index 3");
    expect(deriveFingerprint(exception(libraryChanged))).toBe(deriveFingerprint(exception(STACK)));
  });

  it("uses all frames when none is in-app", () => {
    const library = [
      "TypeError: Cannot read properties of undefined",
      "    at Parser.parse (/app/node_modules/parser/index.js:10:2)",
      "    at node:internal/main/run_main_module:28:49",
    ].join("\n");
    const otherLibrary = library.replace("Parser.parse", "Parser.tokenize");
    const fp = deriveFingerprint(exception(library, "TypeError"));
    expect(deriveFingerprint(exception(library.replace(":10:2", ":99:1"), "TypeError"))).toBe(fp);
    expect(deriveFingerprint(exception(otherLibrary, "TypeError"))).not.toBe(fp);
  });

  it("falls back to the normalized value when there are no frames", () => {
    const a = deriveFingerprint(exception(undefined, "DatabaseError", "timeout after 5000ms"));
    expect(deriveFingerprint(exception("", "DatabaseError", "timeout after 3000ms"))).toBe(a);
    expect(deriveFingerprint(exception(undefined, "DatabaseError", "connection refused"))).not.toBe(a);
  });

  it("groups messages that differ only by numbers, UUIDs, and hex strings", () => {
    expect(deriveFingerprint(log("Order 123 failed"))).toBe(deriveFingerprint(log("Order 456 failed")));
    expect(deriveFingerprint(log("job 6f1c2a9e-3b4d-4c5e-8f70-1a2b3c4d5e6f done"))).toBe(
      deriveFingerprint(log("job 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d done")),
    );
    expect(deriveFingerprint(log("commit 4bf92f3577b34da6 deployed"))).toBe(
      deriveFingerprint(log("commit a1b2c3d4e5f60718 deployed")),
    );
    expect(deriveFingerprint(log("Order 123 failed"))).not.toBe(deriveFingerprint(log("Order 123 shipped")));
  });

  it("is a deterministic SHA-256 hex digest within the fingerprint limit", () => {
    const fp = deriveFingerprint(exception(STACK));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.length).toBeLessThanOrEqual(LIMITS.MAX_FINGERPRINT_CHARS);
    expect(deriveFingerprint(exception(STACK))).toBe(fp);
    expect(deriveFingerprint(log("Order 123 failed"))).toBe(deriveFingerprint(log("Order 123 failed")));
  });

  it("never throws, including for an exception without a stack trace", () => {
    expect(() => deriveFingerprint(exception(undefined))).not.toThrow();
    expect(() => deriveFingerprint({ kind: "exception", message: "no exception object" })).not.toThrow();
    expect(() => deriveFingerprint(log(""))).not.toThrow();
  });
});

describe("normalizeMessage", () => {
  it("replaces numbers, UUIDs, and hex strings with placeholders", () => {
    expect(normalizeMessage("user 42 failed after 3.5s on 6f1c2a9e-3b4d-4c5e-8f70-1a2b3c4d5e6f")).toBe(
      "user <num> failed after <num>s on <uuid>",
    );
    expect(normalizeMessage("commit 4bf92f3577b34da6 at 0xDEADBEEF")).toBe("commit <hex> at <hex>");
    expect(normalizeMessage("invoice inv_000123 retried")).toBe("invoice inv_<num> retried");
    expect(normalizeMessage("utf8 decode failed in v2")).toBe("utf8 decode failed in v2");
  });
});
