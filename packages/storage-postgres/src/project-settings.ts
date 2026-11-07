/**
 * Validation for project-level values stored by the metadata repository:
 * redaction rules (docs/event-format.md, "Privacy defaults") and daily
 * counter increments (docs/retention.md, "What is retained").
 */

import { normalizeKey } from "@jekimo/event-schema";
import type { DailyCounterIncrement, DailyCounterName, RedactionRules } from "./types.js";

export const REDACTION_RULE_LIMITS = {
  MAX_KEYS: 200,
  MAX_KEY_CHARS: 128,
  MAX_PATTERNS: 50,
  MAX_PATTERN_CHARS: 256,
} as const;

/** Counters are kept for 13 months (docs/retention.md). */
export const DAILY_COUNTER_RETENTION_MONTHS = 13;

export const DAILY_COUNTER_NAMES: readonly DailyCounterName[] = ["accepted", "rejected", "dropped", "sampled"];

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written YYYY-MM-DD. */
export function isUtcDay(value: string): boolean {
  if (!UTC_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Normalizes keys like the default list, drops duplicates, and checks that
 * every pattern compiles. Throws RangeError on invalid input.
 */
export function normalizeRedactionRules(rules: RedactionRules): RedactionRules {
  const { MAX_KEYS, MAX_KEY_CHARS, MAX_PATTERNS, MAX_PATTERN_CHARS } = REDACTION_RULE_LIMITS;
  if (!Array.isArray(rules.keys) || !Array.isArray(rules.patterns)) {
    throw new RangeError("redaction rules need keys and patterns arrays");
  }
  const keys: string[] = [];
  for (const raw of rules.keys) {
    if (typeof raw !== "string") throw new RangeError("redaction keys must be strings");
    const key = normalizeKey(raw);
    if (key.length === 0 || key.length > MAX_KEY_CHARS) {
      throw new RangeError(`redaction keys must be 1 to ${MAX_KEY_CHARS} characters after normalization`);
    }
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length > MAX_KEYS) throw new RangeError(`at most ${MAX_KEYS} redaction keys`);
  const patterns: string[] = [];
  rules.patterns.forEach((pattern, n) => {
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN_CHARS) {
      throw new RangeError(`redaction pattern ${n} must be a string of 1 to ${MAX_PATTERN_CHARS} characters`);
    }
    try {
      new RegExp(pattern);
    } catch {
      throw new RangeError(`redaction pattern ${n} is not a valid regular expression`);
    }
    if (!patterns.includes(pattern)) patterns.push(pattern);
  });
  if (patterns.length > MAX_PATTERNS) throw new RangeError(`at most ${MAX_PATTERNS} redaction patterns`);
  return { keys, patterns };
}

/** Checks the day and the counts. Throws RangeError on invalid input. */
export function checkCounterIncrement(input: DailyCounterIncrement): Record<DailyCounterName, number> {
  if (!isUtcDay(input.day)) throw new RangeError("counter day must be a UTC day, YYYY-MM-DD");
  const key = input.idempotencyKey;
  if (key !== undefined && (key.length === 0 || key.length > 200)) {
    throw new RangeError("counter idempotency key must be 1 to 200 characters");
  }
  const counts = { accepted: 0, rejected: 0, dropped: 0, sampled: 0 };
  for (const name of DAILY_COUNTER_NAMES) {
    const n = input[name] ?? 0;
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`counter ${name} must be a non-negative integer`);
    counts[name] = n;
  }
  return counts;
}
