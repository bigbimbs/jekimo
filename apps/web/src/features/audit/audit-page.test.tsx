import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api-client";
import { fakeApi, MEMBER, project, renderApp } from "../../test/render";
import type { AuditEntry, AuditQuery } from "../../types/api";
import { AuditPage } from "./audit-page";

function entry(id: string, action = "auth.two_factor_enabled"): AuditEntry {
  return {
    id,
    occurred_at: "2026-11-11T12:00:00Z",
    actor: null,
    action,
    target: { type: "user", id: "synthetic-user" },
    project_id: null,
    source_ip: "192.0.2.1",
    via_instance_admin: false,
    details: { reason: "<script>synthetic</script>" },
  };
}
const options = () => ({
  listAuditActions: vi.fn().mockResolvedValue(["auth.two_factor_enabled", "member.added"]),
  listProjects: vi.fn().mockResolvedValue([]),
  listUsers: vi.fn().mockResolvedValue([MEMBER]),
});

describe("Audit log", () => {
  it("rejects non-admin views without fetching any audit or user data", async () => {
    const api = fakeApi();
    renderApp(<AuditPage />, { api, user: MEMBER });
    expect(screen.getByText("Only instance admins can view the audit log.")).toBeInTheDocument();
    expect(api.listAudit).not.toHaveBeenCalled();
    expect(api.listUsers).not.toHaveBeenCalled();
    expect(api.listProjects).not.toHaveBeenCalled();
    expect(api.listAuditActions).not.toHaveBeenCalled();
  });

  it("renders system events, escapes details, and appends cursor pages", async () => {
    const listAudit = vi.fn((query: AuditQuery) =>
      Promise.resolve(
        query.cursor ? { entries: [entry("1", "auth.login")] } : { entries: [entry("2")], next_cursor: "2" },
      ),
    );
    const user = userEvent.setup();
    renderApp(<AuditPage />, { api: fakeApi({ ...options(), listAudit }) });
    expect(await screen.findByText("Two-factor authentication enabled", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText("System / operator")).toBeInTheDocument();
    expect(document.querySelector("main script")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Signed in")).toBeInTheDocument();
    expect(listAudit).toHaveBeenLastCalledWith({ limit: 50, cursor: "2" });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("applies actor/action/time filters, resets pagination, and validates the range", async () => {
    const user = userEvent.setup();
    const listAudit = vi.fn().mockResolvedValue({ entries: [], next_cursor: "10" });
    renderApp(<AuditPage />, { api: fakeApi({ ...options(), listAudit }) });
    await screen.findByRole("option", { name: "Member added" });
    await user.selectOptions(screen.getByLabelText("Action"), screen.getByRole("option", { name: "Member added" }));
    await user.selectOptions(screen.getByLabelText("Actor"), MEMBER.id);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-10T12:00" } });
    fireEvent.change(screen.getByLabelText("Before"), { target: { value: "2026-11-11T12:00" } });
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith({
        limit: 50,
        action: "member.added",
        actor: MEMBER.id,
        from: new Date("2026-11-10T12:00").toISOString(),
        to: new Date("2026-11-11T12:00").toISOString(),
      }),
    );
    fireEvent.change(screen.getByLabelText("Before"), { target: { value: "2026-11-09T12:00" } });
    const count = listAudit.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(screen.getByText("The start time must be before the end time.")).toBeInTheDocument();
    expect(listAudit).toHaveBeenCalledTimes(count);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByLabelText("Action")).toHaveValue("");
    expect(screen.getByLabelText("Actor")).toHaveValue("");
  });

  it("keeps existing entries when loading another page fails and allows retry", async () => {
    const user = userEvent.setup();
    const listAudit = vi
      .fn()
      .mockResolvedValueOnce({ entries: [entry("2")], next_cursor: "2" })
      .mockRejectedValueOnce(new ApiError(0, "network", "unreachable"))
      .mockResolvedValue({ entries: [entry("1", "auth.login")] });
    renderApp(<AuditPage />, { api: fakeApi({ ...options(), listAudit }) });
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The server could not be reached");
    expect(screen.getByText("Two-factor authentication enabled", { selector: "td" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Signed in")).toBeInTheDocument();
  });
});

it("shows emails and project names in audit cells while preserving IDs in expandable details", async () => {
  const user = userEvent.setup();
  const records: AuditEntry[] = [
    {
      ...entry("1", "member.added"),
      actor: { user_id: "admin-id", email: "admin@example.test" },
      target: { type: "user", id: MEMBER.id },
      project_id: "prj_a",
    },
    {
      ...entry("2", "project.created"),
      actor: { user_id: MEMBER.id, email: null },
      target: { type: "project", id: "prj_a" },
      project_id: "prj_a",
    },
    {
      ...entry("3", "user.invited"),
      target: { type: "invitation", id: "invite-id" },
      details: { email: "invited@example.test" },
    },
    { ...entry("4", "ingestion_key.created"), target: { type: "ingestion_key", id: "key-id" }, details: {} },
    { ...entry("5", "instance.settings_updated"), target: { type: "instance", id: null }, details: {} },
  ];
  renderApp(<AuditPage />, {
    api: fakeApi({
      ...options(),
      listProjects: vi.fn().mockResolvedValue([project("prj_a", "Billing API")]),
      listAudit: vi.fn().mockResolvedValue({ entries: records }),
    }),
  });
  const table = await screen.findByRole("table");
  const added = within(table).getByRole("row", { name: /Member added/ });
  const cells = within(added).getAllByRole("cell");
  expect(cells[1]).toHaveTextContent("admin@example.test");
  expect(cells[1]).not.toHaveTextContent("admin-id");
  expect(cells[3]).toHaveTextContent("member@example.test");
  expect(cells[3]).toHaveTextContent("User account");
  expect(cells[3]).not.toHaveTextContent(MEMBER.id);
  await waitFor(() => expect(cells[4]).toHaveTextContent("Billing API"));
  const created = within(table).getByRole("row", { name: /Project created/ });
  expect(within(created).getAllByRole("cell")[1]).toHaveTextContent(MEMBER.email);
  expect(within(created).getAllByRole("cell")[3]).toHaveTextContent("Billing API");
  expect(within(table).getByRole("row", { name: /User invited/ })).toHaveTextContent("invited@example.test");
  expect(within(table).getByRole("row", { name: /Ingestion key created/ })).toHaveTextContent("Ingestion key");
  expect(within(table).getByRole("row", { name: /Instance settings updated/ })).toHaveTextContent("Jekimo instance");
  await user.click(within(added).getByText("Details", { exact: true }));
  expect(within(added).getByText("admin-id", { exact: true })).toBeVisible();
  expect(within(added).getByText(MEMBER.id, { exact: true })).toBeVisible();
  expect(within(added).getByText("prj_a", { exact: true })).toBeVisible();
});

it("keeps missing actors distinct from system actions and labels unknown target types safely", async () => {
  renderApp(<AuditPage />, {
    api: fakeApi({
      ...options(),
      listAudit: vi.fn().mockResolvedValue({
        entries: [
          {
            ...entry("1"),
            actor: { user_id: "missing-user", email: null },
            target: { type: "future_target", id: "future-id" },
            details: {},
          },
          {
            ...entry("2", "project.deleted"),
            target: { type: "project", id: "deleted-project" },
            project_id: "deleted-project",
          },
        ],
      }),
    }),
  });
  const table = await screen.findByRole("table");
  expect(within(table).getByText("Deleted or unknown user")).toBeInTheDocument();
  expect(within(table).getByText("Other target")).toBeInTheDocument();
  expect(within(table).getByText("System / operator")).toBeInTheDocument();
  expect(within(table).getAllByText("Unavailable project")).toHaveLength(2);
});
