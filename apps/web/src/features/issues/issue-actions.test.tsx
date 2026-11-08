import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ADMIN, fakeApi, MEMBER, renderApp } from "../../test/render";
import type { Issue, Member, Role } from "../../types/api";
import { IssueActions } from "./issue-actions";

const ISSUE: Issue = {
  id: "iss_1",
  fingerprint: "fp",
  title: "TypeError: x is undefined",
  kind: "exception",
  status: "unresolved",
  last_severity: "error",
  event_count: 3,
  first_seen: "2026-11-07T10:00:00.000Z",
  last_seen: "2026-11-08T10:00:00.000Z",
  environments: ["production"],
};

const ROLES: Role[] = [
  { name: "admin", description: null, permissions: ["project.read", "issues.manage"], built_in: true, member_count: 1 },
  {
    name: "member",
    description: null,
    permissions: ["project.read", "issues.manage"],
    built_in: true,
    member_count: 1,
  },
  { name: "viewer", description: null, permissions: ["project.read"], built_in: true, member_count: 1 },
];

function membership(role: string): Member[] {
  return [{ user_id: MEMBER.id, email: MEMBER.email, status: "active", role, created_at: "2026-11-01T00:00:00Z" }];
}

describe("IssueActions", () => {
  it("shows nothing to a viewer, who lacks issues.manage", async () => {
    const api = fakeApi({
      listMembers: vi.fn().mockResolvedValue(membership("viewer")),
      listRoles: vi.fn().mockResolvedValue(ROLES),
    });
    renderApp(<IssueActions projectId="prj_a" issue={ISSUE} />, { api, user: MEMBER });
    await waitFor(() => expect(api.listRoles).toHaveBeenCalledWith("prj_a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers resolve and ignore to a member with issues.manage", async () => {
    const changeIssueStatus = vi.fn().mockResolvedValue({ ...ISSUE, status: "resolved" });
    const api = fakeApi({
      listMembers: vi.fn().mockResolvedValue(membership("Member")),
      listRoles: vi.fn().mockResolvedValue(ROLES),
      changeIssueStatus,
    });
    renderApp(<IssueActions projectId="prj_a" issue={ISSUE} />, { api, user: MEMBER });
    await userEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    expect(screen.getByRole("button", { name: "Ignore" })).toBeInTheDocument();
    expect(changeIssueStatus).toHaveBeenCalledWith("prj_a", "iss_1", "resolve");
  });

  it("offers reopen on a resolved issue to an instance admin without asking for roles", () => {
    const api = fakeApi();
    renderApp(<IssueActions projectId="prj_a" issue={{ ...ISSUE, status: "resolved" }} />, { api, user: ADMIN });
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
    expect(api.listMembers).not.toHaveBeenCalled();
  });
});
