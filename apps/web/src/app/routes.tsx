import { Navigate, type RouteObject } from "react-router";
import { InvitationsPage } from "../features/admin/invitations-page";
import { UsersPage } from "../features/admin/users-page";
import { AuditPage } from "../features/audit/audit-page";
import { LinkPasswordPage } from "../features/auth/link-password-page";
import { RequireSession } from "../features/auth/require-session";
import { SetupPage } from "../features/auth/setup-page";
import { SignInPage } from "../features/auth/sign-in-page";
import { CronPage } from "../features/cron/cron-page";
import { DashboardPage } from "../features/dashboard/dashboard-page";
import { DatabasePage } from "../features/database/database-page";
import { EventDetailPage } from "../features/events/event-detail-page";
import { EventListPage } from "../features/events/event-list-page";
import { IssueDetailPage } from "../features/issues/issue-detail-page";
import { IssueListPage } from "../features/issues/issue-list-page";
import { MembersPage } from "../features/members/members-page";
import { EmailPage } from "../features/notifications/email-page";
import { ProjectNotifications } from "../features/notifications/project-notifications";
import { HomeRedirect } from "../features/projects/home-redirect";
import { ProjectLayout } from "../features/projects/project-layout";
import { SecurityPage } from "../features/security/security-page";
import { SettingsPage } from "../features/settings/settings-page";
import { TracePage } from "../features/traces/trace-page";
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
      { path: "/security", element: <SecurityPage /> },
      { path: "/admin/email", element: <EmailPage /> },
      { path: "/admin/users", element: <UsersPage /> },
      { path: "/admin/invitations", element: <InvitationsPage /> },
      { path: "/admin/audit-log", element: <AuditPage /> },
      {
        path: "/projects/:projectId",
        element: <ProjectLayout />,
        children: [
          { index: true, element: <Navigate to="dashboard" replace /> },
          { path: "dashboard", element: <DashboardPage /> },
          { path: "logs", element: <EventListPage kind="log" key="logs" /> },
          { path: "logs/:eventId", element: <EventDetailPage kind="log" /> },
          { path: "events", element: <EventListPage kind="event" key="events" /> },
          { path: "events/:eventId", element: <EventDetailPage kind="event" /> },
          { path: "issues", element: <IssueListPage /> },
          { path: "issues/:issueId", element: <IssueDetailPage /> },
          { path: "traces", element: <TracePage /> },
          { path: "traces/:traceId", element: <TracePage /> },
          { path: "database", element: <DatabasePage /> },
          { path: "cron", element: <CronPage /> },
          { path: "alerts", element: <ProjectNotifications page="alerts" /> },
          { path: "integrations", element: <ProjectNotifications page="integrations" /> },
          { path: "settings", element: <SettingsPage /> },
          { path: "members", element: <MembersPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
];
