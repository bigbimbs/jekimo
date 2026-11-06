/**
 * Deterministic sampling. Normative text: docs/retention.md, "Sampling".
 *
 * The decision depends only on the event_id, so the SDK and the server reach
 * the same answer and an event is never half-sampled across retries.
 */

import { type EventEnvelope, type Severity, ULID_PATTERN } from "./types.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Number of trailing ULID characters used for the sampling fraction (5 bits each). */
const SAMPLE_CHARS = 8;
const SAMPLE_SPACE = 2 ** (5 * SAMPLE_CHARS); // 2^40

/** Severities that are never sampled out. */
export const ALWAYS_KEPT_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(["error", "fatal"]);

/**
 * Maps a ULID to a fraction in [0, 1) from its last 40 random bits.
 * Throws for a string that is not a ULID.
 */
export function ulidSampleFraction(eventId: string): number {
  if (!ULID_PATTERN.test(eventId)) throw new RangeError("eventId is not a ULID");
  let n = 0;
  for (const ch of eventId.slice(-SAMPLE_CHARS)) {
    n = n * 32 + CROCKFORD.indexOf(ch);
  }
  return n / SAMPLE_SPACE;
}

/** Clamps a configured sample rate into [0, 1]; non-numbers become 1 (keep everything). */
export function normalizeSampleRate(rate: unknown): number {
  if (typeof rate !== "number" || Number.isNaN(rate)) return 1;
  return Math.min(1, Math.max(0, rate));
}

/**
 * Decides whether to keep an event under a project's sample rate. Exceptions
 * and error/fatal events are always kept; everything else is kept when the
 * event's sampling fraction is below the rate.
 */
export function shouldKeepEvent(
  event: Pick<EventEnvelope, "event_id" | "kind" | "severity">,
  sampleRate: number,
): boolean {
  if (event.kind === "exception" || ALWAYS_KEPT_SEVERITIES.has(event.severity)) return true;
  const rate = normalizeSampleRate(sampleRate);
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return ulidSampleFraction(event.event_id) < rate;
}
