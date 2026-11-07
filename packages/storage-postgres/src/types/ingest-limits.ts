import type { IngestChargeOutcome } from "../constants/ingest-limits.js";
import type { Actor, ProjectAccess } from "./access.js";

/** A project's own settings; null inherits the instance-wide default. */
export interface IngestLimitSettings {
  rateLimitPerMinute: number | null;
  eventsPerDay: number | null;
}

/** Limits after defaults are resolved. `eventsPerDay` null means no quota. */
export interface IngestLimits {
  ratePerMinute: number;
  eventsPerDay: number | null;
}

/** Events admitted in the current UTC minute and UTC day. */
export interface IngestUsage {
  minuteEvents: number;
  dayEvents: number;
}

export interface IngestChargeResult extends IngestUsage {
  outcome: IngestChargeOutcome;
}

export interface IngestUsageRow {
  minuteStart: Date;
  minuteEvents: number;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  dayEvents: number;
}

export interface IngestLimitStore {
  /** Null when the project does not exist. */
  read(projectId: string, now: Date): Promise<(IngestLimitSettings & IngestUsage) | null>;
  /** Atomic across API processes; see decideCharge for the rules. */
  charge(projectId: string, now: Date, events: number, limits: IngestLimits): Promise<IngestChargeResult>;
  getSettings(access: ProjectAccess): Promise<IngestLimitSettings>;
  /** Instance admins only (docs/retention.md, "Quotas"). Audited. Throws RangeError on invalid settings. */
  setSettings(
    actor: Actor,
    access: ProjectAccess,
    settings: IngestLimitSettings,
    sourceIp?: string,
  ): Promise<IngestLimitSettings>;
}
