import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet } from "react-router";
import { expect, it, vi } from "vitest";
import { fakeApi, project, renderApp } from "../../test/render";
import { CronPage } from "./cron-page";

const monitor = {
  id: "monitor",
  name: "Nightly backup",
  expression: "0 2 * * *",
  timezone: "UTC",
  graceSeconds: 60,
  maxRuntimeSeconds: 300,
  failureThreshold: 1,
  recoveryThreshold: 1,
  channelId: null,
  enabled: true,
  health: "failing" as const,
  nextExpectedAt: "2026-11-16T02:00:00Z",
  lastSuccessAt: null,
  consecutiveFailures: 1,
  consecutiveSuccesses: 0,
  incidentOpen: true,
};
it("shows monitor health and readable run history", async () => {
  const api = fakeApi({
    listCronMonitors: vi.fn().mockResolvedValue([monitor]),
    listNotificationChannels: vi.fn().mockResolvedValue([]),
    listCronRuns: vi.fn().mockResolvedValue([
      {
        id: "run",
        status: "missed",
        startedAt: null,
        finishedAt: "2026-11-15T02:01:01Z",
        expectedAt: "2026-11-15T02:00:00Z",
        deadlineAt: null,
      },
    ]),
  });
  renderApp(
    [
      {
        path: "/",
        element: <Outlet context={{ project: project("one") }} />,
        children: [{ index: true, element: <CronPage /> }],
      },
    ],
    { api },
  );
  await screen.findByText("Needs attention");
  await userEvent.setup().click(screen.getByRole("button", { name: "View runs and setup" }));
  await screen.findByText("Missed start");
  expect(api.listCronRuns).toHaveBeenCalledWith("one", "monitor");
});
it("creates a monitor with schedule and thresholds", async () => {
  const api = fakeApi({
    listCronMonitors: vi.fn().mockResolvedValue([]),
    listNotificationChannels: vi.fn().mockResolvedValue([]),
    createCronMonitor: vi.fn().mockResolvedValue(monitor),
  });
  renderApp(
    [
      {
        path: "/",
        element: <Outlet context={{ project: project("one") }} />,
        children: [{ index: true, element: <CronPage /> }],
      },
    ],
    { api },
  );
  const user = userEvent.setup();
  await screen.findByLabelText("Job name");
  await user.type(screen.getByLabelText("Job name"), "Nightly backup");
  await user.click(screen.getByRole("button", { name: "Add monitor" }));
  await screen.findByText("Monitor created.");
  expect(api.createCronMonitor).toHaveBeenCalledWith(
    "one",
    expect.objectContaining({ name: "Nightly backup", expression: "0 2 * * *", timezone: "UTC", channelId: null }),
  );
});
