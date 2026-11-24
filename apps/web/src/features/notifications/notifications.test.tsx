import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet } from "react-router";
import { expect, it, vi } from "vitest";
import { fakeApi, MEMBER, project, renderApp } from "../../test/render";
import { EmailPage } from "./email-page";
import { ProjectNotifications } from "./project-notifications";

it("does not request SMTP credentials for a non-admin", () => {
  const api = fakeApi();
  renderApp(<EmailPage />, { api, user: MEMBER });
  expect(api.getEmailSettings).not.toHaveBeenCalled();
});
it("saves SMTP settings without caching the password", async () => {
  const config = {
    available: true,
    settings: {
      host: "smtp.example.test",
      port: 587,
      security: "starttls" as const,
      username: "user",
      from: "alerts@example.test",
      fromName: "Jekimo",
      enabled: true,
      hasPassword: true,
    },
  };
  const api = fakeApi({
    getEmailSettings: vi.fn().mockResolvedValue(config),
    saveEmailSettings: vi.fn().mockResolvedValue(config),
    listNotificationDeliveries: vi.fn().mockResolvedValue([]),
  });
  const view = renderApp(<EmailPage />, { api });
  await screen.findByLabelText("Password", { exact: false });
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Password", { exact: false }), "synthetic-secret");
  await user.click(screen.getByRole("button", { name: "Save settings" }));
  await screen.findByText("Settings saved.");
  expect(api.saveEmailSettings).toHaveBeenCalledWith(expect.objectContaining({ password: "synthetic-secret" }));
  expect(
    JSON.stringify(
      view.queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("synthetic-secret");
  expect(view.queryClient.getMutationCache().getAll()).toHaveLength(0);
  expect(screen.getByLabelText("Password", { exact: false })).toHaveValue("");
});
it("creates a project connection and clears its destination", async () => {
  const api = fakeApi({
    listNotificationChannels: vi.fn().mockResolvedValue([]),
    listNotificationDeliveries: vi.fn().mockResolvedValue([]),
    createNotificationChannel: vi.fn().mockResolvedValue({ id: "channel", name: "Ops", kind: "email", enabled: true }),
  });
  renderApp(
    [
      {
        path: "/",
        element: <Outlet context={{ project: project("one") }} />,
        children: [{ index: true, element: <ProjectNotifications page="integrations" /> }],
      },
    ],
    { api },
  );
  const user = userEvent.setup();
  await screen.findByLabelText("Name");
  await user.type(screen.getByLabelText("Name"), "Ops");
  await user.type(screen.getByLabelText("Recipient email"), "ops@example.test");
  await user.click(screen.getByRole("button", { name: "Add connection" }));
  await waitFor(() =>
    expect(api.createNotificationChannel).toHaveBeenCalledWith("one", {
      name: "Ops",
      kind: "email",
      destination: "ops@example.test",
    }),
  );
  await screen.findByText("Settings saved.");
  expect(screen.getByLabelText("Recipient email")).toHaveValue("");
});

it("creates and edits a slow-query rule with saved filters", async () => {
  const rule = {
    id: "rule",
    name: "Slow invoices",
    channelId: "channel",
    trigger: "slow_query" as const,
    thresholdMs: 500,
    environment: "production",
    queryName: "invoices.list",
    cooldownMinutes: 15,
    enabled: true,
  };
  const api = fakeApi({
    listNotificationChannels: vi.fn().mockResolvedValue([{ id: "channel", name: "Ops", kind: "email", enabled: true }]),
    listAlertRules: vi.fn().mockResolvedValue([]),
    listNotificationDeliveries: vi.fn().mockResolvedValue([]),
    saveAlertRule: vi.fn().mockResolvedValue(rule),
  });
  renderApp(
    [
      {
        path: "/",
        element: <Outlet context={{ project: project("one") }} />,
        children: [{ index: true, element: <ProjectNotifications page="alerts" /> }],
      },
    ],
    { api },
  );
  const user = userEvent.setup();
  await screen.findByLabelText("Name");
  await user.type(screen.getByLabelText("Name"), "Slow invoices");
  await user.selectOptions(screen.getByLabelText("Connection"), "channel");
  await user.selectOptions(screen.getByLabelText("Notify when"), "slow_query");
  await user.clear(screen.getByLabelText("Duration threshold (ms)"));
  await user.type(screen.getByLabelText("Duration threshold (ms)"), "500");
  await user.type(screen.getByLabelText("Environment (optional)"), "production");
  await user.type(screen.getByLabelText("Operation name (optional)"), "invoices.list");
  vi.mocked(api.listAlertRules).mockResolvedValue([rule]);
  await user.click(screen.getByRole("button", { name: "Create alert rule" }));
  await screen.findByText("Settings saved.");
  expect(api.saveAlertRule).toHaveBeenCalledWith(
    "one",
    expect.objectContaining({
      thresholdMs: 500,
      environment: "production",
      queryName: "invoices.list",
      trigger: "slow_query",
    }),
    undefined,
  );
  await user.click(screen.getByRole("button", { name: "Edit rule" }));
  expect(screen.getByLabelText("Duration threshold (ms)")).toHaveValue(500);
  await user.clear(screen.getByLabelText("Duration threshold (ms)"));
  await user.type(screen.getByLabelText("Duration threshold (ms)"), "750");
  await user.click(screen.getByRole("button", { name: "Save rule" }));
  await waitFor(() =>
    expect(api.saveAlertRule).toHaveBeenLastCalledWith(
      "one",
      expect.objectContaining({ thresholdMs: 750, enabled: true }),
      "rule",
    ),
  );
});
