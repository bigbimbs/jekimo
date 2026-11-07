import type { EventEnvelope } from "@jekimo/event-schema";
import { ISSUE_TITLE_MAX_LENGTH } from "./constants/index.js";

export function issueTitle(event: EventEnvelope): string {
  const title = event.exception ? `${event.exception.type}: ${event.exception.value ?? event.message}` : event.message;
  return title.length > ISSUE_TITLE_MAX_LENGTH ? `${title.slice(0, ISSUE_TITLE_MAX_LENGTH - 1)}…` : title;
}
