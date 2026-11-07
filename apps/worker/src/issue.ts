import type { EventEnvelope } from "@jekimo/event-schema";

/** Human-readable issue title. */
export function issueTitle(event: EventEnvelope): string {
  const title = event.exception ? `${event.exception.type}: ${event.exception.value ?? event.message}` : event.message;
  return title.length > 256 ? `${title.slice(0, 255)}…` : title;
}
