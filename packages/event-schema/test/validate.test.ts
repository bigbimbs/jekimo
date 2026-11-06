import { describe, expect, it } from "vitest";
import { isRedactedKey, LIMITS, SCHEMA_VERSION, validateEvent } from "../src/index.js";
import { clone, exceptionExample, invalidCases, loadExamples, type Mutable } from "./fixtures.js";

const examples = loadExamples();
const base = () => clone(exceptionExample()) as Mutable;
const now = new Date("2026-11-05T12:00:00Z");

describe("validateEvent: examples", () => {
  for (const { name, event } of examples) {
    it(`${name} is valid in stored mode`, () => {
      const result = validateEvent(event, { mode: "stored", now });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) {
        expect(result.warnings).toEqual([]);
        expect(result.event).toEqual(event);
      }
    });

    it(`${name} is rejected in ingest mode because it carries project_id`, () => {
      const result = validateEvent(event, { mode: "ingest", now });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([expect.objectContaining({ path: "/project_id", code: "forbidden" })]);
      }
    });

    it(`${name} is valid in ingest mode once project_id is removed`, () => {
      const e = clone(event) as Mutable;
      delete e.project_id;
      const result = validateEvent(e, { mode: "ingest", now });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    });
  }

  it("defaults to ingest mode", () => {
    const e = base();
    delete e.project_id;
    expect(validateEvent(e, { now }).ok).toBe(true);
    expect(validateEvent(base(), { now }).ok).toBe(false);
  });
});

describe("validateEvent: invalid inputs", () => {
  for (const c of invalidCases) {
    if (c.valid) {
      it(`accepts ${c.name}`, () => {
        const e = base();
        c.mutate(e);
        expect(validateEvent(e, { mode: "stored", now }).ok).toBe(true);
      });
      continue;
    }
    it(`rejects ${c.name} with code ${c.code}`, () => {
      const e = base();
      c.mutate(e);
      const result = validateEvent(e, { mode: "stored", now });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.map((i) => i.code)).toContain(c.code);
      }
    });
  }

  it("rejects non-object input without throwing", () => {
    for (const input of [null, undefined, 1, "x", [], true]) {
      const result = validateEvent(input, { now });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]).toMatchObject({ path: "", code: "type" });
    }
  });

  it("requires project_id in stored mode", () => {
    const e = base();
    delete e.project_id;
    const result = validateEvent(e, { mode: "stored", now });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual([expect.objectContaining({ path: "/project_id", code: "required" })]);
  });

  it("reports every problem, not just the first", () => {
    const e = base();
    delete e.message;
    e.severity = "loud";
    e.event_id = "nope";
    const result = validateEvent(e, { mode: "stored", now });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((i) => i.path).sort()).toEqual(["/event_id", "/message", "/severity"]);
    }
  });
});

describe("validateEvent: forward compatibility", () => {
  it("drops unknown top-level fields with a warning", () => {
    const e = base();
    e.future_field = { anything: true };
    e.exception.frames = [];
    const result = validateEvent(e, { mode: "stored", now });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.map((w) => w.path).sort()).toEqual(["/exception/frames", "/future_field"]);
      expect(result.warnings.every((w) => w.code === "unknown_field")).toBe(true);
      expect("future_field" in result.event).toBe(false);
      expect("frames" in (result.event.exception ?? {})).toBe(false);
    }
  });

  it("returns a canonical copy with only known fields, in schema order", () => {
    const e = base();
    const result = validateEvent({ attributes: e.attributes, message: e.message, ...e }, { mode: "stored", now });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.event).slice(0, 4)).toEqual(["schema_version", "event_id", "project_id", "timestamp"]);
    }
  });
});

describe("validateEvent: timestamps", () => {
  it("accepts a timestamp within the future skew allowance", () => {
    const e = base();
    e.timestamp = new Date(now.getTime() + LIMITS.MAX_FUTURE_SKEW_MS - 1000).toISOString();
    expect(validateEvent(e, { mode: "stored", now }).ok).toBe(true);
  });

  it("honours a custom maxFutureSkewMs", () => {
    const e = base();
    e.timestamp = new Date(now.getTime() + 2000).toISOString();
    expect(validateEvent(e, { mode: "stored", now, maxFutureSkewMs: 1000 }).ok).toBe(false);
    expect(validateEvent(e, { mode: "stored", now, maxFutureSkewMs: 3000 }).ok).toBe(true);
  });

  it("accepts numeric offsets and fractional seconds", () => {
    const e = base();
    e.timestamp = "2026-11-05T10:14:33.123456+01:00";
    expect(validateEvent(e, { mode: "stored", now }).ok).toBe(true);
  });

  it("rejects a well-formed but impossible date", () => {
    const e = base();
    e.timestamp = "2026-13-45T25:61:00Z";
    const result = validateEvent(e, { mode: "stored", now });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.code).toBe("invalid_timestamp");
  });
});

describe("constants", () => {
  it("exposes the schema version", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("matches redacted keys case-insensitively and ignoring separators", () => {
    expect(isRedactedKey("Authorization")).toBe(true);
    expect(isRedactedKey("api_key")).toBe(true);
    expect(isRedactedKey("API-KEY")).toBe(true);
    expect(isRedactedKey("Set-Cookie")).toBe(true);
    expect(isRedactedKey("invoice_id")).toBe(false);
    expect(isRedactedKey("tokens_used")).toBe(false);
  });
});
