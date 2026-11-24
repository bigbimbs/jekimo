import { PROJECT_PERMISSIONS } from "@jekimo/event-schema/constants";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api-client";
import { queryKeys } from "../../lib/query-keys";
import { fakeApi, MEMBER, project, renderApp } from "../../test/render";
import type { Member, Role } from "../../types/api";
import { ProjectLayout } from "../projects/project-layout";
import { MembersPage, MembersSection } from "./members-page";

const ROLES: Role[] = [
  { name: "admin", permissions: [...PROJECT_PERMISSIONS], description: null, built_in: true, member_count: 1 },
  { name: "viewer", permissions: ["project.read"], description: null, built_in: true, member_count: 1 },
  {
    name: "organizer",
    permissions: ["project.read", "members.manage"],
    description: null,
    built_in: false,
    member_count: 1,
  },
];

function member(userId = "u-other", role = "viewer"): Member {
  return {
    user_id: userId,
    email: `${userId}@example.test`,
    status: "active",
    role,
    created_at: "2026-11-01T00:00:00.000Z",
  };
}

const ROUTES = [
  {
    path: "/projects/:projectId",
    element: <ProjectLayout />,
    children: [{ path: "members", element: <MembersPage /> }],
  },
];

function memberApi(members: Member[] = [member()]) {
  return {
    listMembers: vi.fn().mockResolvedValue(members),
    listRoles: vi.fn().mockResolvedValue(ROLES),
  };
}

describe("Project members", () => {
  it("lets viewers read members without mutation controls", async () => {
    const api = fakeApi(memberApi([member(MEMBER.id)]));
    renderApp(<MembersSection projectId="prj_a" />, { api, user: MEMBER });
    expect(await screen.findByRole("table")).toHaveTextContent(`${MEMBER.id}@example.test`);
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText(/Managing membership requires/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change role" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("adds an existing user by email and refreshes membership", async () => {
    const reads = memberApi([]);
    const added = member();
    const addMember = vi.fn().mockImplementation(async () => {
      reads.listMembers.mockResolvedValue([added]);
      return added;
    });
    const user = userEvent.setup();
    renderApp(<MembersSection projectId="prj_a" />, { api: fakeApi({ ...reads, addMember }) });
    await user.click(await screen.findByRole("button", { name: "Add member" }));
    expect(screen.getByText(/existing account on this instance/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), added.email);
    await user.selectOptions(screen.getByLabelText("Role"), "viewer");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add member" }));
    expect(await screen.findByRole("table")).toHaveTextContent(added.email);
    expect(addMember).toHaveBeenCalledWith("prj_a", added.email, "viewer");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("limits assignable roles and target members by permissions, including custom roles", async () => {
    const user = userEvent.setup();
    renderApp(<MembersSection projectId="prj_a" />, {
      user: MEMBER,
      api: fakeApi(memberApi([member(MEMBER.id, "organizer"), member("u-admin", "admin"), member()])),
    });
    const table = await screen.findByRole("table");
    const adminRow = within(table).getByText("u-admin@example.test").closest("tr");
    expect(adminRow).not.toHaveTextContent("Change role");
    expect(screen.getAllByRole("button", { name: "Change role" })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Add member" }));
    expect(within(screen.getByLabelText("Role")).queryByRole("option", { name: "admin" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Role")).getByRole("option", { name: "organizer" })).toBeInTheDocument();
  });

  it("changes a role and reloads the displayed membership", async () => {
    const reads = memberApi();
    const changeMemberRole = vi.fn().mockImplementation(async () => {
      reads.listMembers.mockResolvedValue([member("u-other", "organizer")]);
      return member("u-other", "organizer");
    });
    const user = userEvent.setup();
    renderApp(<MembersSection projectId="prj_a" />, { api: fakeApi({ ...reads, changeMemberRole }) });
    await user.click(await screen.findByRole("button", { name: "Change role" }));
    expect(screen.getByRole("button", { name: "Save role" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Role"), "organizer");
    await user.click(screen.getByRole("button", { name: "Save role" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("organizer")).toBeInTheDocument();
    expect(changeMemberRole).toHaveBeenCalledWith("prj_a", "u-other", "organizer");
  });

  it("requires confirmation for removal and preserves the last-admin error", async () => {
    const removeMember = vi.fn().mockRejectedValue(new ApiError(409, "last_admin", "last admin"));
    const user = userEvent.setup();
    renderApp(<MembersSection projectId="prj_a" />, {
      api: fakeApi({ ...memberApi([member("u-other", "admin")]), removeMember }),
    });
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    expect(removeMember).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeMember).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Remove member" }));
    expect(await screen.findByText("A project needs at least one admin.")).toBeInTheDocument();
    expect(removeMember).toHaveBeenCalledExactlyOnceWith("prj_a", "u-other");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("removes a member once and prevents repeated submissions while the request is pending", async () => {
    const reads = memberApi([{ ...member(), status: "deactivated" }]);
    let finish: () => void = () => undefined;
    const removeMember = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            reads.listMembers.mockResolvedValue([]);
            resolve();
          };
        }),
    );
    const user = userEvent.setup();
    renderApp(<MembersSection projectId="prj_a" />, { api: fakeApi({ ...reads, removeMember }) });
    expect(await screen.findByText("Deactivated")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.dblClick(screen.getByRole("button", { name: "Remove member" }));
    expect(removeMember).toHaveBeenCalledExactlyOnceWith("prj_a", "u-other");
    expect(screen.getByRole("button", { name: "Remove member" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => finish());
    expect(await screen.findByText("No project members yet.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not fetch members for a project outside the user's accessible projects", async () => {
    const api = fakeApi({ ...memberApi(), listProjects: vi.fn().mockResolvedValue([project("prj_a")]) });
    renderApp(ROUTES, { api, path: "/projects/prj_other/members" });
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(api.listMembers).not.toHaveBeenCalled();
    expect(api.listRoles).not.toHaveBeenCalled();
  });

  it.each([
    [404, "user_not_found", "No account exists with that email."],
    [409, "already_member", "This user is already a member of the project."],
    [403, "role_escalation", "You cannot grant or change a role with more permissions than your own."],
  ])("shows an actionable %s %s error without closing the form", async (status, code, message) => {
    const user = userEvent.setup();
    renderApp(<MembersSection projectId="prj_a" />, {
      api: fakeApi({ ...memberApi(), addMember: vi.fn().mockRejectedValue(new ApiError(status, code, "failure")) }),
    });
    await user.click(await screen.findByRole("button", { name: "Add member" }));
    await user.type(screen.getByLabelText("Email"), "new@example.test");
    await user.selectOptions(screen.getByLabelText("Role"), "viewer");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add member" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    expect(screen.getByLabelText("Email")).toHaveValue("new@example.test");
  });

  it("refreshes permissions after self-demotion", async () => {
    const reads = memberApi([member(MEMBER.id, "organizer")]);
    const changeMemberRole = vi.fn().mockImplementation(async () => {
      reads.listMembers.mockResolvedValue([member(MEMBER.id, "viewer")]);
      return member(MEMBER.id, "viewer");
    });
    const user = userEvent.setup();
    renderApp(<MembersSection projectId="prj_a" />, { user: MEMBER, api: fakeApi({ ...reads, changeMemberRole }) });
    await user.click(await screen.findByRole("button", { name: "Change role" }));
    expect(screen.getByText(/Changing your own role/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Role"), "viewer");
    await user.click(screen.getByRole("button", { name: "Save role" }));
    expect(await screen.findByText(/Managing membership requires/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("drops project access and cached data immediately after self-removal, even if refreshing fails", async () => {
    const listProjects = vi.fn().mockResolvedValue([project("prj_a")]);
    const removeMember = vi.fn().mockImplementation(async () => {
      listProjects.mockRejectedValue(new ApiError(0, "network", "unreachable"));
    });
    const user = userEvent.setup();
    const { queryClient } = renderApp(ROUTES, {
      path: "/projects/prj_a/members",
      user: MEMBER,
      api: fakeApi({ ...memberApi([member(MEMBER.id, "organizer")]), listProjects, removeMember }),
    });
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    expect(screen.getByText(/removing your own membership/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove member" }));
    await waitFor(() => expect(screen.queryByRole("table")).not.toBeInTheDocument());
    expect(queryClient.getQueryData(queryKeys.projects)).toEqual([]);
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.project("prj_a") })).toHaveLength(0);
  });

  it("clears the old project's members and open dialog when navigating to another project", async () => {
    let resolveB: (value: Member[]) => void = () => undefined;
    const listMembers = vi.fn((id: string) =>
      id === "prj_a"
        ? Promise.resolve([member("alpha")])
        : new Promise<Member[]>((resolve) => {
            resolveB = resolve;
          }),
    );
    const user = userEvent.setup();
    const { router, queryClient } = renderApp(ROUTES, {
      path: "/projects/prj_a/members",
      api: fakeApi({
        ...memberApi(),
        listMembers,
        listProjects: vi.fn().mockResolvedValue([project("prj_a"), project("prj_b")]),
      }),
    });
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await act(() => router.navigate("/projects/prj_b/members"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("alpha@example.test")).not.toBeInTheDocument();
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.project("prj_a") })).toHaveLength(0);
    await act(async () => resolveB([member("beta")]));
    expect(await screen.findByText("beta@example.test")).toBeInTheDocument();
  });

  it("offers retry after a membership load failure", async () => {
    const reads = memberApi();
    reads.listMembers.mockRejectedValueOnce(new ApiError(0, "network", "unreachable"));
    const user = userEvent.setup();
    renderApp(<MembersSection projectId="prj_a" />, { api: fakeApi(reads) });
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table")).toHaveTextContent("u-other@example.test");
  });
});
