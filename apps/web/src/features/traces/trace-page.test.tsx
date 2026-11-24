import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet } from "react-router";
import { expect, it, vi } from "vitest";
import { fakeApi, project, renderApp } from "../../test/render";
import { TraceLink } from "./trace-link";
import { TracePage } from "./trace-page";

const traceId = "a".repeat(32);
const routes = [
  {
    path: "/",
    element: <Outlet context={{ project: project("one") }} />,
    children: [{ path: "traces/:traceId", element: <TracePage /> }],
  },
];
const record = {
  received_at: "2026-11-17T12:00:00Z",
  key_id: "synthetic",
  event: {
    schema_version: 1,
    event_id: "sample",
    timestamp: "2026-11-17T12:00:00Z",
    kind: "event",
    severity: "info",
    message: "invoices.list",
    context: { trace_id: traceId },
    database: { name: "invoices.list", system: "postgresql", operation: "select", duration_ms: 250, status: "ok" },
  },
};
it("shows correlated queries and paginates without changing the trace or window", async () => {
  const listEvents = vi
    .fn()
    .mockResolvedValueOnce({ events: [record], next_cursor: "next" })
    .mockResolvedValue({
      events: [
        {
          ...record,
          event: { ...record.event, event_id: "second", message: "invoice complete", kind: "log", database: undefined },
        },
      ],
    });
  renderApp(routes, { path: `/traces/${traceId}`, api: fakeApi({ listEvents }) });
  await screen.findByText("invoices.list");
  expect(screen.getByText("250 ms · Completed")).toBeInTheDocument();
  const first = listEvents.mock.calls[0]?.[1];
  expect(first).toMatchObject({ trace_id: traceId, limit: 100 });
  expect(first.kind).toBeUndefined();
  expect(first.database).toBeUndefined();
  await userEvent.setup().click(screen.getByRole("button", { name: "Load more records" }));
  await screen.findByText("invoice complete");
  expect(listEvents).toHaveBeenLastCalledWith("one", { ...first, cursor: "next" });
});
it("does not query malformed trace IDs", () => {
  const api = fakeApi();
  renderApp(routes, { path: "/traces/not-a-trace", api });
  expect(api.listEvents).not.toHaveBeenCalled();
  expect(screen.getByText(/Enter a nonzero trace ID/)).toBeInTheDocument();
});
it("links older records with a receipt window and hides redacted IDs", () => {
  renderApp(
    <>
      <TraceLink projectId="one" traceId={traceId} receivedAt="2026-11-01T00:00:00Z" />
      <TraceLink projectId="one" traceId="[REDACTED]" receivedAt="2026-11-01T00:00:00Z" />
    </>,
  );
  const links = screen.getAllByRole("link", { name: "View request trace" });
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute("href")).toContain("from=2026-10-31");
});
