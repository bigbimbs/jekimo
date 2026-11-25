import { MAX_SPAN_DURATION_MS, SPAN_ID_PATTERN } from "../../constants/tracing";
import type { StoredEvent } from "../../types/api";
import type { WaterfallSpan } from "../../types/tracing";

export function waterfallSpans(records: StoredEvent[]): WaterfallSpan[] {
  const spans = new Map<string, WaterfallSpan>();
  for (const { event } of records) {
    const context = event.context;
    const id = context?.span_id;
    if (!id || !SPAN_ID_PATTERN.test(id) || spans.has(id)) continue;
    let start: number, duration: number, status: "ok" | "error", operation: string;
    if (event.database) {
      duration = event.database.duration_ms;
      start = Date.parse(event.timestamp) - duration;
      status = event.database.status;
      operation = event.database.system;
    } else {
      if (context?.span_type !== "span" || !context.span_duration_ms?.trim()) continue;
      if (context.span_status !== "ok" && context.span_status !== "error") continue;
      duration = Number(context.span_duration_ms);
      start = Date.parse(context.span_started_at ?? "");
      status = context.span_status;
      operation = context.span_operation ?? "";
    }
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration < 0 || duration > MAX_SPAN_DURATION_MS)
      continue;
    const parentId = context?.parent_span_id;
    spans.set(id, {
      id,
      eventId: event.event_id,
      name: event.message,
      operation,
      status,
      start,
      duration,
      depth: 0,
      missingParent: Boolean(parentId && !SPAN_ID_PATTERN.test(parentId)),
      ...(parentId && SPAN_ID_PATTERN.test(parentId) && { parentId }),
    });
  }
  for (const span of spans.values()) {
    let parentId = span.parentId;
    const visited = new Set([span.id]);
    while (parentId && span.depth < 8) {
      const parent = spans.get(parentId);
      if (!parent || visited.has(parentId)) {
        span.missingParent = true;
        break;
      }
      visited.add(parentId);
      span.depth++;
      parentId = parent.parentId;
    }
  }
  return [...spans.values()].sort((a, b) => a.start - b.start || a.depth - b.depth || a.id.localeCompare(b.id));
}
