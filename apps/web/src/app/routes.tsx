import type { RouteObject } from "react-router";
import { LinkPasswordPage } from "../features/auth/link-password-page";
import { RequireSession } from "../features/auth/require-session";
import { SetupPage } from "../features/auth/setup-page";
import { SignInPage } from "../features/auth/sign-in-page";
import { IssueDetailPage } from "../features/issues/issue-detail-page";
import { IssueListPage } from "../features/issues/issue-list-page";
import { HomeRedirect } from "../features/projects/home-redirect";
import { ProjectLayout } from "../features/projects/project-layout";
import { SettingsPage } from "../features/settings/settings-page";
import { NotFoundPage } from "./not-found-page";

// /invite and /reset-password match the links the API issues
// (apps/api/README.md, invitation and reset links).
export const routes: RouteObject[] = [
  { path: "/setup", element: <SetupPage /> },
  { path: "/sign-in", element: <SignInPage /> },
  { path: "/invite", element: <LinkPasswordPage mode="invite" /> },
  { path: "/reset-password", element: <LinkPasswordPage mode="reset" /> },
  {
    element: <RequireSession />,
    children: [
      { index: true, element: <HomeRedirect /> },
      {
        path: "/projects/:projectId",
        element: <ProjectLayout />,
        children: [
          { index: true, element: <IssueListPage /> },
          { path: "issues", element: <IssueListPage /> },
          { path: "issues/:issueId", element: <IssueDetailPage /> },
          { path: "settings", element: <SettingsPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
];
