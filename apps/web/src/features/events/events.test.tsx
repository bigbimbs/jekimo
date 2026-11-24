import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api-client";
import { fakeApi, project, renderApp } from "../../test/render";
import type { StoredEvent } from "../../types/api";
import { ProjectLayout } from "../projects/project-layout";
import { EventDetailPage } from "./event-detail-page";
import { EventListPage } from "./event-list-page";

const routes = [
  {
    path: "/projects/:projectId",
    element: <ProjectLayout />,
    children: [
      { path: "logs", element: <EventListPage kind="log" key="logs" /> },
      { path: "events", element: <EventListPage kind="event" key="events" /> },
      { path: "logs/:eventId", element: <EventDetailPage kind="log" /> },
      { path: "events/:eventId", element: <EventDetailPage kind="event" /> },
    ],
  },
];
function record(id: string, kind: "log" | "event", message: string): StoredEvent {
  return {
    received_at: "2026-11-11T12:00:00Z",
    key_id: "synthetic",
    event: {
      schema_version: 1,
      event_id: id,
      timestamp: "2026-11-11T11:59:00Z",
      kind,
      severity: "info",
      message,
      service: "billing",
      environment: "staging",
      attributes: { attempt: 2 },
    },
  };
}
const listProjects = () => Promise.resolve([project("prj_a")]);

describe("Separate logs and events", () => {
  it("pins each route to its kind, preserves the query window across pages, and resets pagination on search", async () => {
    const user = userEvent.setup();
    const first = record("record1", "log", "Invoice queued");
    const second = record("record2", "log", "Invoice sent");
    const listEvents = vi
      .fn()
      .mockResolvedValueOnce({ events: [first], next_cursor: "next-log" })
      .mockResolvedValueOnce({ events: [second] })
      .mockResolvedValue({ events: [] });
    renderApp(routes, { api: fakeApi({ listProjects, listEvents }), path: "/projects/prj_a/logs?kind=event" });
    expect(await screen.findByRole("link", { name: "Invoice queued" })).toHaveAttribute(
      "href",
      "/projects/prj_a/logs/record1",
    );
    const firstQuery = listEvents.mock.calls[0]?.[1];
    expect(firstQuery).toMatchObject({ kind: "log", limit: 50 });
    expect(Date.parse(firstQuery.to) - Date.parse(firstQuery.from)).toBe(86_400_000);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Invoice sent")).toBeInTheDocument();
    expect(listEvents).toHaveBeenLastCalledWith("prj_a", { ...firstQuery, cursor: "next-log" });
    await user.type(screen.getByLabelText("Search messages"), "invoice");
    await user.type(screen.getByLabelText("Environment"), "production");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(listEvents).toHaveBeenLastCalledWith("prj_a", { ...firstQuery, q: "invoice", environment: "production" }),
    );
    expect(await screen.findByText("No logs found")).toBeInTheDocument();
    expect(screen.queryByText("Invoice queued")).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation")).getByRole("link", { name: "Events" }));
    expect(await screen.findByText("No events found")).toBeInTheDocument();
    expect(listEvents).toHaveBeenLastCalledWith("prj_a", expect.objectContaining({ kind: "event" }));
    expect(listEvents.mock.lastCall?.[1]).not.toHaveProperty("cursor");
    expect(listEvents.mock.lastCall?.[1]).not.toHaveProperty("q");
  });

  it("applies severity and receipt time filters to the API", async () => {
    const user = userEvent.setup();
    const listEvents = vi.fn().mockResolvedValue({ events: [] });
    renderApp(routes, { api: fakeApi({ listProjects, listEvents }), path: "/projects/prj_a/events" });
    await screen.findByText("No events found");
    await user.selectOptions(screen.getByLabelText("Severity"), "warning");
    await user.selectOptions(screen.getByLabelText("Received"), "7d");
    await waitFor(() => expect(listEvents.mock.lastCall?.[1]).toMatchObject({ kind: "event", severity: "warning" }));
    const query = listEvents.mock.lastCall?.[1];
    expect(Date.parse(query.to) - Date.parse(query.from)).toBe(7 * 86_400_000);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.getByLabelText("Severity")).toHaveValue(""));
  });

  it("shows a failed query as an error with retry instead of an empty log", async () => {
    const user = userEvent.setup();
    const listEvents = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, "internal", "failed"))
      .mockResolvedValue({ events: [] });
    renderApp(routes, { api: fakeApi({ listProjects, listEvents }), path: "/projects/prj_a/logs" });
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No logs found")).toBeInTheDocument();
  });

  it("opens record details and keeps a log out of the custom event route", async () => {
    const getEvent = vi.fn().mockResolvedValue(record("record1", "log", "Synthetic log message"));
    const { router } = renderApp(routes, {
      api: fakeApi({ listProjects, getEvent }),
      path: "/projects/prj_a/logs/record1",
    });
    expect(await screen.findByText("Synthetic log message")).toBeInTheDocument();
    expect(screen.getAllByText('"attempt": 2', { exact: false }).length).toBeGreaterThan(0);
    expect(getEvent).toHaveBeenCalledWith("prj_a", "record1");
    await router.navigate("/projects/prj_a/events/record1");
    expect(await screen.findByText("Record not found")).toBeInTheDocument();
    expect(screen.queryByText("Synthetic log message")).not.toBeInTheDocument();
  });
});
