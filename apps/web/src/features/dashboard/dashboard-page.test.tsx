import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { routes } from "../../app/routes";
import { ApiError } from "../../lib/api-client";
import { ADMIN, fakeApi, project, renderApp } from "../../test/render";
import { ProjectLayout } from "../projects/project-layout";
import { DashboardPage } from "./dashboard-page";

const summary = {
  from: "2026-11-10T12:30:00.000Z",
  to: "2026-11-11T12:30:00.000Z",
  activity: [
    { hour: "2026-11-11T10:00:00.000Z", kind: "log", severity: "info", count: 1234 },
    { hour: "2026-11-11T10:00:00.000Z", kind: "event", severity: "info", count: 17 },
    { hour: "2026-11-11T11:00:00.000Z", kind: "exception", severity: "error", count: 3 },
  ],
};
const dashboardRoutes = [
  {
    path: "/projects/:projectId",
    element: <ProjectLayout />,
    children: [{ path: "dashboard", element: <DashboardPage /> }],
  },
];

describe("Project dashboard", () => {
  it("shows server aggregate totals, an hourly chart, and dedicated exploration routes", async () => {
    const api = fakeApi({
      listProjects: vi.fn().mockResolvedValue([project("prj_a")]),
      getEventSummary: vi.fn().mockResolvedValue(summary),
      listIssues: vi.fn().mockResolvedValue({ issues: [] }),
    });
    renderApp(dashboardRoutes, { api, path: "/projects/prj_a/dashboard" });
    expect(await screen.findByText("1,254")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Stored records by receipt time/ })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    for (const [label, path] of [
      ["Issues", "issues"],
      ["Logs", "logs"],
      ["Events", "events"],
    ] as const) {
      expect(within(screen.getByRole("navigation")).getByRole("link", { name: label })).toHaveAttribute(
        "href",
        `/projects/prj_a/${path}`,
      );
    }
    expect(api.listIssues).toHaveBeenCalledWith("prj_a", { status: "unresolved", limit: 5 });
    expect(api.listEvents).not.toHaveBeenCalled();
  });

  it("does not display zero totals when the summary request fails", async () => {
    renderApp(dashboardRoutes, {
      api: fakeApi({
        listProjects: vi.fn().mockResolvedValue([project("prj_a")]),
        getEventSummary: vi.fn().mockRejectedValue(new ApiError(500, "internal", "failed")),
        listIssues: vi.fn().mockResolvedValue({ issues: [] }),
      }),
      path: "/projects/prj_a/dashboard",
    });
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("Total records")).not.toBeInTheDocument();
  });

  it("lands the project root on the dashboard instead of the issue list", async () => {
    const { router } = renderApp(routes, {
      api: fakeApi({
        getSession: vi.fn().mockResolvedValue({ user: ADMIN, csrf_token: "synthetic" }),
        listProjects: vi.fn().mockResolvedValue([project("prj_a")]),
        getEventSummary: vi.fn().mockResolvedValue({ ...summary, activity: [] }),
        listIssues: vi.fn().mockResolvedValue({ issues: [] }),
      }),
      path: "/projects/prj_a",
    });
    expect(await screen.findByText("No activity in the last 24 hours")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects/prj_a/dashboard");
  });
});
