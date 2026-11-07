import { ULID_PATTERN, ulidSampleFraction } from "@jekimo/event-schema";
import { describe, expect, it } from "vitest";
import { createUlidGenerator } from "../src/ulid.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function decodeTime(id: string): number {
  return [...id.slice(0, 10)].reduce((n, ch) => n * 32 + CROCKFORD.indexOf(ch), 0);
}

describe("ULID generation", () => {
  it("produces valid ULIDs that encode the timestamp", () => {
    const now = Date.parse("2026-11-05T09:14:33.412Z");
    const id = createUlidGenerator(() => now)();
    expect(id).toMatch(ULID_PATTERN);
    expect(decodeTime(id)).toBe(now);
  });

  it("is strictly increasing within one millisecond", () => {
    const next = createUlidGenerator(() => 1_700_000_000_000);
    const ids = Array.from({ length: 1000 }, next);
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(ids.every((id) => decodeTime(id) === 1_700_000_000_000)).toBe(true);
  });

  it("stays monotonic when the clock moves backwards", () => {
    let t = 1_700_000_000_500;
    const next = createUlidGenerator(() => t);
    const a = next();
    t -= 400;
    const b = next();
    expect(b > a).toBe(true);
    expect(decodeTime(b)).toBe(1_700_000_000_500);
  });

  it("gives same-millisecond IDs independent sampling fractions", () => {
    const next = createUlidGenerator(() => 1_700_000_000_000);
    const fractions = Array.from({ length: 2000 }, () => ulidSampleFraction(next()));
    const kept = fractions.filter((f) => f < 0.5).length;
    expect(kept).toBeGreaterThan(800);
    expect(kept).toBeLessThan(1200);
  });

  it("uses fresh randomness for each new millisecond", () => {
    let t = 1_700_000_000_000;
    const next = createUlidGenerator(() => t++);
    const ids = new Set(Array.from({ length: 1000 }, next));
    expect(ids.size).toBe(1000);
  });
});
