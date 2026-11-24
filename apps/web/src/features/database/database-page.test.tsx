import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet } from "react-router";
import { expect, it, vi } from "vitest";
import { fakeApi, project, renderApp } from "../../test/render";
import { DatabasePage } from "./database-page";

const metrics = { count: 3, errors: 1, slow: 2, averageMs: 300, p95Ms: 480, totalMs: 900 };
it("shows performance groups and applies environment and threshold filters", async () => {
  const getDatabaseSummary = vi.fn().mockResolvedValue({
    totals: metrics,
    groups: [{ ...metrics, name: "invoices.list", system: "postgresql", operation: "select" }],
    recent: [],
  });
  renderApp(
    [
      {
        path: "/",
        element: <Outlet context={{ project: project("one") }} />,
        children: [{ index: true, element: <DatabasePage /> }],
      },
    ],
    { api: fakeApi({ getDatabaseSummary }) },
  );
  await screen.findByText("invoices.list");
  expect(screen.getAllByText("480 ms").length).toBeGreaterThan(0);
  expect(screen.getByText("Read")).toBeInTheDocument();
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText("Slow query threshold (ms)"));
  await user.type(screen.getByLabelText("Slow query threshold (ms)"), "500");
  await user.type(screen.getByLabelText("Environment"), "production");
  await user.click(screen.getByRole("button", { name: "Apply and refresh" }));
  expect(getDatabaseSummary).toHaveBeenLastCalledWith(
    "one",
    expect.objectContaining({ slow_ms: 500, environment: "production" }),
  );
});
it("shows an honest setup state when no calls are recorded", async () => {
  renderApp(
    [
      {
        path: "/",
        element: <Outlet context={{ project: project("one") }} />,
        children: [{ index: true, element: <DatabasePage /> }],
      },
    ],
    {
      api: fakeApi({
        getDatabaseSummary: vi.fn().mockResolvedValue({
          totals: { count: 0, errors: 0, slow: 0, averageMs: 0, p95Ms: 0, totalMs: 0 },
          groups: [],
          recent: [],
        }),
      }),
    },
  );
  await screen.findByText("No database calls recorded");
  expect(screen.getByText(/SQL text, parameters, and results are not collected/)).toBeInTheDocument();
});
