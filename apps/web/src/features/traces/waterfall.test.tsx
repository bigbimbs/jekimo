import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../../test/render";
import type { StoredEvent } from "../../types/api";
import { TraceWaterfall } from "./trace-waterfall";
import { waterfallSpans } from "./waterfall";

function record(id: string, duration: string, parent?: string): StoredEvent {
  return {
    received_at: "2026-11-24T10:00:01Z",
    key_id: "synthetic",
    event: {
      schema_version: 1,
      event_id: id,
      timestamp: "2026-11-24T10:00:00Z",
      kind: "event",
      severity: "info",
      message: `operation-${id}`,
      context: {
        span_id: id.repeat(16),
        span_type: "span",
        span_started_at: "2026-11-24T10:00:00Z",
        span_duration_ms: duration,
        span_status: "ok",
        ...(parent && { parent_span_id: parent.repeat(16) }),
      },
    },
  };
}
it("orders timing records, derives query starts and tolerates missing parents, cycles and invalid fields", () => {
  const root = record("a", "100"),
    child = record("b", "30", "a"),
    orphan = record("c", "0", "d");
  const query = record("e", "40", "a");
  query.event.database = { name: "db", system: "postgresql", operation: "select", duration_ms: 10, status: "error" };
  query.event.timestamp = "2026-11-24T10:00:00.050Z";
  const spans = waterfallSpans([
    child,
    root,
    orphan,
    query,
    record("f", "Infinity"),
    record("1", "-1"),
    record("2", "[REDACTED]"),
    record("3", ""),
    record("4", "604800001"),
  ]);
  expect(spans.map((s) => s.id[0])).toEqual(["a", "c", "b", "e"]);
  expect(spans.find((s) => s.id[0] === "b")?.depth).toBe(1);
  expect(spans.find((s) => s.id[0] === "c")?.missingParent).toBe(true);
  expect(spans.find((s) => s.id[0] === "e")?.start).toBe(Date.parse("2026-11-24T10:00:00.040Z"));
  expect(waterfallSpans([record("a", "1", "b"), record("b", "1", "a")]).every((s) => s.missingParent)).toBe(true);
});
it("shows accessible timings, record links and a partial-data notice", () => {
  renderApp(<TraceWaterfall records={[record("a", "100"), record("b", "20", "f")]} hasMore />);
  expect(screen.getByRole("region", { name: "Timing waterfall" })).toBeInTheDocument();
  expect(screen.getByText("+0 ms · 100 ms")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "operation-a" })).toHaveAttribute("href", "#record-a");
  expect(screen.getByText(/More records are available/)).toBeInTheDocument();
  expect(screen.getByText("Parent span is missing or invalid")).toBeInTheDocument();
});

it("reports a zero-duration span without inventing elapsed time", () => {
  renderApp(<TraceWaterfall records={[record("a", "0")]} hasMore={false} />);
  expect(screen.getByText("1 recorded span over 0 ms")).toBeInTheDocument();
});
