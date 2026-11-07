import { describe, expect, it } from "vitest";
import { normalizeSampleRate, shouldKeepEvent, ulidSampleFraction } from "../src/index.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Deterministic pseudo-random ULIDs for distribution tests (not for production use). */
function fakeUlids(count: number, seed = 42): string[] {
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
  return Array.from({ length: count }, () => {
    let id = "0";
    for (let i = 1; i < 26; i++) id += CROCKFORD[next() % 32];
    return id;
  });
}

const base = { kind: "log" as const, severity: "info" as const };

describe("ulidSampleFraction", () => {
  it("is deterministic and within [0, 1)", () => {
    const id = "01JBQ4Z3H8X9T2K7M5N6P8R9SV";
    const f = ulidSampleFraction(id);
    expect(f).toBe(ulidSampleFraction(id));
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
  });

  it("uses only the trailing random characters", () => {
    const tail = "N6P8R9SV";
    expect(ulidSampleFraction(`01JBQ4Z3H8X9T2K7M5${tail}`)).toBe(ulidSampleFraction(`7${"Z".repeat(17)}${tail}`));
    expect(ulidSampleFraction("0".repeat(26))).toBe(0);
    expect(ulidSampleFraction(`${"0".repeat(18)}${"Z".repeat(8)}`)).toBeCloseTo(1, 6);
  });

  it("rejects non-ULIDs", () => {
    expect(() => ulidSampleFraction("not-a-ulid")).toThrow(RangeError);
  });

  it("is roughly uniform", () => {
    const ids = fakeUlids(20000);
    const kept = ids.filter((id) => ulidSampleFraction(id) < 0.25).length / ids.length;
    expect(kept).toBeGreaterThan(0.23);
    expect(kept).toBeLessThan(0.27);
  });
});

describe("normalizeSampleRate", () => {
  it("clamps into [0, 1] and defaults to 1", () => {
    expect(normalizeSampleRate(0.5)).toBe(0.5);
    expect(normalizeSampleRate(-1)).toBe(0);
    expect(normalizeSampleRate(2)).toBe(1);
    expect(normalizeSampleRate("0.5")).toBe(1);
    expect(normalizeSampleRate(Number.NaN)).toBe(1);
    expect(normalizeSampleRate(undefined)).toBe(1);
  });
});

describe("shouldKeepEvent", () => {
  const ids = fakeUlids(2000);

  it("keeps everything at rate 1 and drops all sampleable events at rate 0", () => {
    expect(ids.every((event_id) => shouldKeepEvent({ event_id, ...base }, 1))).toBe(true);
    expect(ids.some((event_id) => shouldKeepEvent({ event_id, ...base }, 0))).toBe(false);
  });

  it("never samples exceptions or error/fatal events", () => {
    for (const event_id of ids.slice(0, 200)) {
      expect(shouldKeepEvent({ event_id, kind: "exception", severity: "warning" }, 0)).toBe(true);
      expect(shouldKeepEvent({ event_id, kind: "log", severity: "error" }, 0)).toBe(true);
      expect(shouldKeepEvent({ event_id, kind: "event", severity: "fatal" }, 0)).toBe(true);
    }
  });

  it("samples debug, info, and warning logs and events at the configured rate", () => {
    const kept =
      ids.filter((event_id) => shouldKeepEvent({ event_id, kind: "event", severity: "warning" }, 0.5)).length /
      ids.length;
    expect(kept).toBeGreaterThan(0.45);
    expect(kept).toBeLessThan(0.55);
  });

  it("gives the same answer for the same event on every call", () => {
    for (const event_id of ids.slice(0, 100)) {
      const first = shouldKeepEvent({ event_id, ...base }, 0.3);
      expect(shouldKeepEvent({ event_id, ...base }, 0.3)).toBe(first);
    }
  });
});
