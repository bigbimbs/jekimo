import { ULID_PATTERN } from "@jekimo/event-schema";
import type { EventPage, EventQuery, ProjectAccess } from "@jekimo/storage-postgres";
import { searchWords } from "@jekimo/storage-postgres";
import { DAY_MS } from "../../constants/index.js";
import { ApiError } from "../../errors.js";
import type { EventServiceDeps } from "../../types/index.js";

export class EventService {
  constructor(private readonly deps: EventServiceDeps) {}

  /** Defaults to the 24 hours before `to`, and `to` to now. */
  window(from: Date | undefined, to: Date | undefined): { from: Date; to: Date } {
    const end = to ?? this.deps.clock();
    const start = from ?? new Date(end.getTime() - DAY_MS);
    if (start >= end) throw new ApiError(400, "invalid_request", "from must be before to");
    return { from: start, to: end };
  }

  assertSearchable(text: string): void {
    if (!this.deps.events.capabilities.textSearch)
      throw new ApiError(400, "invalid_request", "text search is not available on this event store");
    if (searchWords(text).length === 0)
      throw new ApiError(400, "invalid_request", "q must contain at least one letter or digit");
  }

  async query(access: ProjectAccess, query: EventQuery): Promise<EventPage> {
    try {
      return await this.deps.events.queryEvents(access.projectId, query);
    } catch (err) {
      if (err instanceof RangeError) throw new ApiError(400, "invalid_request", "cursor is not valid");
      throw err;
    }
  }

  async get(access: ProjectAccess, eventId: string) {
    // The project comes from the access check, so an event_id from another
    // project is simply not found here.
    const found = ULID_PATTERN.test(eventId) ? await this.deps.events.getEvent(access.projectId, eventId) : null;
    if (!found) throw new ApiError(404, "not_found", "event not found");
    return found;
  }
}
