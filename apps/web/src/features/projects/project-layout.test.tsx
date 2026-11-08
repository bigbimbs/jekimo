import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, project, renderApp } from "../../test/render";
import type { IssuePage } from "../../types/api";
import { IssueListPage } from "../issues/issue-list-page";
import { ProjectLayout } from "./project-layout";

const ROUTES = [
  {
    path: "/projects/:projectId",
    element: <ProjectLayout />,
    children: [{ path: "issues", element: <IssueListPage /> }],
  },
];

function page(title: string): IssuePage {
  return {
    issues: [
      {
        id: `iss_${title}`,
        fingerprint: "fp",
        title,
        kind: "exception",
        status: "unresolved",
        last_severity: "error",
        event_count: 1,
        first_seen: "2026-11-08T00:00:00.000Z",
        last_seen: "2026-11-08T00:00:00.000Z",
        environments: [],
      },
    ],
  };
}

describe("ProjectLayout", () => {
  it("switches projects without showing or keeping the previous project's data", async () => {
    let resolveB: (p: IssuePage) => void = () => undefined;
    const listIssues = vi.fn((projectId: string) =>
      projectId === "prj_a"
        ? Promise.resolve(page("Error in A"))
        : new Promise<IssuePage>((resolve) => {
            resolveB = resolve;
          }),
    );
    const api = fakeApi({
      listProjects: vi.fn().mockResolvedValue([project("prj_a", "Alpha"), project("prj_b", "Beta")]),
      listIssues,
    });
    const user = userEvent.setup();
    const { queryClient } = renderApp(ROUTES, { api, path: "/projects/prj_a/issues" });

    expect(await screen.findByText("Error in A")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Project: Alpha/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Beta" }));

    expect(await screen.findByRole("button", { name: /Project: Beta/ })).toBeInTheDocument();
    expect(screen.queryByText("Error in A")).not.toBeInTheDocument();
    expect(queryClient.getQueryCache().findAll({ queryKey: ["project", "prj_a"] })).toHaveLength(0);

    resolveB(page("Error in B"));
    expect(await screen.findByText("Error in B")).toBeInTheDocument();
  });

  it("does not render a project the user cannot access", async () => {
    const api = fakeApi({ listProjects: vi.fn().mockResolvedValue([project("prj_a")]) });
    renderApp(ROUTES, { api, path: "/projects/prj_other/issues" });
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(api.listIssues).not.toHaveBeenCalled();
  });
});
