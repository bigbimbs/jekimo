import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api-client";
import { queryKeys } from "../../lib/query-keys";
import { ADMIN, fakeApi, MEMBER, renderApp } from "../../test/render";
import type { AccountUser, Invitation } from "../../types/api";
import { AccountLinkDialog } from "./account-link-dialog";
import { InvitationsPage } from "./invitations-page";
import { UsersPage } from "./users-page";

const admin: AccountUser = { ...ADMIN, status: "active" };
const member: AccountUser = { ...MEMBER, status: "active" };
const invitation: Invitation = {
  id: "invite-synthetic",
  email: "new@example.test",
  instance_role: "member",
  created_by: ADMIN.id,
  created_at: "2026-11-12T12:00:00Z",
  expires_at: "2026-11-19T12:00:00Z",
};
function row(email: string) {
  return screen.getByRole("row", { name: new RegExp(email.replaceAll(".", "\\.")) });
}

async function openAction(user: ReturnType<typeof userEvent.setup>, email: string, action: string) {
  await user.click(within(row(email)).getByRole("button", { name: `Actions for ${email}` }));
  await user.click(screen.getByRole("menuitem", { name: action }));
}

describe("Admin users", () => {
  it("blocks members without reading admin data", () => {
    const api = fakeApi();
    renderApp(<UsersPage />, { api, user: MEMBER });
    expect(screen.getByText("Only instance admins can manage users and invitations.")).toBeInTheDocument();
    expect(api.listUsers).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Change role" })).not.toBeInTheDocument();
  });

  it("filters users and confirms deactivation and reactivation", async () => {
    const user = userEvent.setup();
    let current = member;
    const listUsers = vi.fn(async () => [admin, current]);
    const updateUser = vi.fn(async (_id, change) => {
      current = { ...current, ...change };
      return current;
    });
    renderApp(<UsersPage />, { api: fakeApi({ listUsers, updateUser }) });
    await screen.findByRole("table");
    await user.type(screen.getByLabelText("Search by email"), "member");
    expect(screen.queryByRole("row", { name: /admin@example/ })).not.toBeInTheDocument();
    await openAction(user, member.email, "Deactivate");
    expect(updateUser).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(row(member.email)).toHaveTextContent("Deactivated"));
    expect(updateUser).toHaveBeenLastCalledWith(member.id, { status: "deactivated" });
    await openAction(user, member.email, "Reactivate");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reactivate" }));
    await waitFor(() => expect(row(member.email)).toHaveTextContent("Active"));
    expect(updateUser).toHaveBeenLastCalledWith(member.id, { status: "active" });
  });

  it("protects the last active admin and reports a server-side last-admin race", async () => {
    const user = userEvent.setup();
    const updateUser = vi.fn().mockRejectedValue(new ApiError(409, "last_admin", "last active admin"));
    renderApp(<UsersPage />, { api: fakeApi({ listUsers: vi.fn().mockResolvedValue([admin, member]), updateUser }) });
    await screen.findByRole("table");
    await openAction(user, admin.email, "Deactivate");
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Deactivate" })).toBeDisabled();
    expect(screen.getByText(/The instance must keep at least one active admin/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await openAction(user, member.email, "Change role");
    await user.selectOptions(within(screen.getByRole("dialog")).getByLabelText("Instance role"), "admin");
    await user.click(screen.getByRole("button", { name: "Save role" }));
    expect(await screen.findByText(/The instance must keep at least one active admin/)).toBeInTheDocument();
    expect(updateUser).toHaveBeenCalledWith(member.id, { instance_role: "admin" });
  });

  it("clears admin and project caches after self-demotion and keeps the new session role", async () => {
    const user = userEvent.setup();
    const otherAdmin = { ...member, instance_role: "admin" as const };
    const api = fakeApi({
      listUsers: vi.fn().mockResolvedValue([admin, otherAdmin]),
      updateUser: vi.fn().mockResolvedValue({ ...admin, instance_role: "member" }),
    });
    const { queryClient, router } = renderApp(
      [
        { path: "/admin/users", element: <UsersPage /> },
        { path: "/", element: <p>Project home</p> },
      ],
      { api, path: "/admin/users" },
    );
    queryClient.setQueryData(queryKeys.session, { user: ADMIN, csrf_token: "synthetic" });
    queryClient.setQueryData(["admin", "audit", {}], { entries: [{ action: "synthetic" }] });
    queryClient.setQueryData(["project", "prj_a", "keys"], []);
    await screen.findByRole("table");
    await openAction(user, admin.email, "Change role");
    await user.selectOptions(within(screen.getByRole("dialog")).getByLabelText("Instance role"), "member");
    expect(screen.getByText(/removes your instance administration access/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save role" }));
    expect(await screen.findByText("Project home")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(queryClient.getQueryCache().findAll({ queryKey: ["admin"] })).toHaveLength(0);
    expect(queryClient.getQueryCache().findAll({ queryKey: ["project"] })).toHaveLength(0);
    expect(queryClient.getQueryData(queryKeys.session)).toMatchObject({ user: { instance_role: "member" } });
  });

  it("shows a reset link only once and never retains it in query or mutation data", async () => {
    const user = userEvent.setup();
    const link = "/reset-password#token=synthetic-reset-secret";
    const api = fakeApi({
      listUsers: vi.fn().mockResolvedValue([admin, member]),
      createPasswordReset: vi.fn().mockResolvedValue({ reset: { expires_at: invitation.expires_at }, link }),
    });
    const { queryClient } = renderApp(<UsersPage />, { api });
    await screen.findByRole("table");
    await openAction(user, member.email, "Create reset link");
    expect(api.createPasswordReset).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create reset link" }));
    expect(await screen.findByLabelText("Single-use link")).toHaveValue(new URL(link, window.location.origin).href);
    expect(api.createPasswordReset).toHaveBeenCalledWith(member.id);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("synthetic-reset-secret");
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
    ).not.toContain("synthetic-reset-secret");
    await user.click(screen.getByRole("button", { name: "I have saved the link" }));
    expect(screen.queryByLabelText("Single-use link")).not.toBeInTheDocument();
  });
});

describe("Admin invitations", () => {
  it("blocks non-admins without loading invitations or opening a create dialog", () => {
    const api = fakeApi();
    renderApp([{ path: "/admin/invitations", element: <InvitationsPage /> }], {
      api,
      user: MEMBER,
      path: "/admin/invitations?invite=1",
    });
    expect(api.listInvitations).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("creates a member invitation by default, copies its absolute link, and drops it when closed", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const listInvitations = vi.fn().mockResolvedValue([]);
    const link = "/invite#token=synthetic-invite-secret";
    const createInvitation = vi.fn().mockImplementation(async () => {
      listInvitations.mockResolvedValue([invitation]);
      return { invitation, link };
    });
    const { queryClient } = renderApp(<InvitationsPage />, { api: fakeApi({ listInvitations, createInvitation }) });
    await screen.findByText("No pending invitations");
    await user.click(screen.getByRole("button", { name: "Invite user" }));
    await user.type(screen.getByLabelText("Email"), invitation.email);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Invite user" }));
    expect(await screen.findByLabelText("Single-use link")).toHaveValue(new URL(link, window.location.origin).href);
    expect(createInvitation).toHaveBeenCalledWith(invitation.email, "member");
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(copy).toHaveBeenCalledWith(new URL(link, window.location.origin).href);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("synthetic-invite-secret");
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
    ).not.toContain("synthetic-invite-secret");
    await user.click(screen.getByRole("button", { name: "I have saved the link" }));
    expect(screen.queryByLabelText("Single-use link")).not.toBeInTheDocument();
    expect(await screen.findByRole("table")).toHaveTextContent(invitation.email);
  });

  it("requires confirmation to revoke and refreshes the pending list", async () => {
    const user = userEvent.setup();
    const listInvitations = vi.fn().mockResolvedValue([invitation]);
    const revokeInvitation = vi.fn().mockImplementation(async () => {
      listInvitations.mockResolvedValue([]);
    });
    renderApp(<InvitationsPage />, { api: fakeApi({ listInvitations, revokeInvitation }) });
    await user.click(await screen.findByRole("button", { name: "Revoke invitation" }));
    expect(revokeInvitation).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke invitation" }));
    expect(await screen.findByText("No pending invitations")).toBeInTheDocument();
    expect(revokeInvitation).toHaveBeenCalledWith(invitation.id);
  });

  it("shows API errors and lets the admin correct an invitation", async () => {
    const user = userEvent.setup();
    const createInvitation = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "email_taken", "exists"))
      .mockResolvedValue({ invitation, link: "/invite#token=synthetic-retry" });
    renderApp(<InvitationsPage />, {
      api: fakeApi({ listInvitations: vi.fn().mockResolvedValue([]), createInvitation }),
    });
    await user.click(screen.getByRole("button", { name: "Invite user" }));
    await user.type(screen.getByLabelText("Email"), "existing@example.test");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Invite user" }));
    expect(await screen.findByText("An account with this email already exists.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), invitation.email);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Invite user" }));
    expect(await screen.findByLabelText("Single-use link")).toBeInTheDocument();
  });
});

it("offers manual copying when clipboard access fails", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  renderApp(
    <AccountLinkDialog
      issued={{
        kind: "invite",
        email: invitation.email,
        link: "/invite#token=synthetic-copy",
        expiresAt: invitation.expires_at,
      }}
      onClose={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Copy link" }));
  expect(await screen.findByText("Copy failed. Select and copy the link manually.")).toBeInTheDocument();
  expect(screen.getByLabelText("Single-use link")).toHaveValue(
    new URL("/invite#token=synthetic-copy", window.location.origin).href,
  );
});

it("clears the session and leaves administration after self-deactivation", async () => {
  const user = userEvent.setup();
  const api = fakeApi({
    listUsers: vi.fn().mockResolvedValue([admin, { ...member, instance_role: "admin" }]),
    updateUser: vi.fn().mockResolvedValue({ ...admin, status: "deactivated" }),
  });
  const { queryClient } = renderApp(
    [
      { path: "/admin/users", element: <UsersPage /> },
      { path: "/sign-in", element: <p>Signed out</p> },
    ],
    { api, path: "/admin/users" },
  );
  queryClient.setQueryData(queryKeys.session, { user: ADMIN, csrf_token: "synthetic" });
  await screen.findByRole("table");
  await openAction(user, admin.email, "Deactivate");
  expect(screen.getByText(/You are deactivating your own account/)).toBeInTheDocument();
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deactivate" }));
  expect(await screen.findByText("Signed out")).toBeInTheDocument();
  expect(queryClient.getQueryData(queryKeys.session)).toBeUndefined();
  expect(queryClient.getQueryCache().findAll({ queryKey: ["admin"] })).toHaveLength(0);
});
