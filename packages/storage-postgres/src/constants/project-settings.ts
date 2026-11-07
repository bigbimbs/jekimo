export const REDACTION_RULE_LIMITS = {
  MAX_KEYS: 200,
  MAX_KEY_CHARS: 128,
  MAX_PATTERNS: 50,
  MAX_PATTERN_CHARS: 256,
} as const;

/** docs/retention.md, "What is retained". */
export const DAILY_COUNTER_RETENTION_MONTHS = 13;

export const DAILY_COUNTER_NAMES = ["accepted", "rejected", "dropped", "sampled"] as const;
export type DailyCounterName = (typeof DAILY_COUNTER_NAMES)[number];
