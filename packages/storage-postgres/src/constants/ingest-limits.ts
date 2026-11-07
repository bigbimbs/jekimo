export const INGEST_LIMIT_BOUNDS = {
  /** One full request of 100 events must always fit in a minute. */
  MIN_PER_MINUTE: 100,
  MAX_PER_MINUTE: 1_000_000,
  MIN_PER_DAY: 1,
  MAX_PER_DAY: 1_000_000_000_000,
} as const;

/** docs/ingestion-protocol.md, "Rate limits and quotas". */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 1000;

export const INGEST_CHARGE_OUTCOMES = ["admitted", "rate_limited", "quota_exceeded"] as const;
export type IngestChargeOutcome = (typeof INGEST_CHARGE_OUTCOMES)[number];
