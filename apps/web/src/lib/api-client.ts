import { API_BASE, CSRF_HEADER } from "../constants/api";
import type { IssueAction } from "../constants/issues";
import type {
  AccountUser,
  Api,
  ApiClientOptions,
  ApiErrorBody,
  AuditPage,
  EventPage,
  EventSummary,
  IngestionKey,
  Invitation,
  Issue,
  IssueDetail,
  IssuedInvitation,
  IssuedKey,
  IssuedPasswordReset,
  IssuePage,
  IssueQuery,
  Member,
  Project,
  RequestOptions,
  Role,
  SessionResponse,
  SetupResponse,
  StoredEvent,
  TwoFactorSetup,
  TwoFactorStatus,
} from "../types/api";
import type { CronMonitor, CronRun } from "../types/cron";
import type { DatabaseSummary } from "../types/database";
import type { AlertRule, EmailConfiguration, NotificationChannel, NotificationDelivery } from "../types/notifications";

/** An API answer other than 2xx, or `network` when the request never got one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function segment(id: string): string {
  return encodeURIComponent(id);
}

function projectPath(projectId: string, rest = ""): string {
  return `/projects/${segment(projectId)}${rest}`;
}

/**
 * The CSRF token lives in memory only, from the session or sign-in response,
 * and goes on every state-changing request (docs/access-model.md, "Sessions").
 */
export function createApiClient(options: ApiClientOptions = {}): Api & { setCsrfToken(token: string | null): void } {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  let csrfToken: string | null = null;

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && csrfToken) headers[CSRF_HEADER] = csrfToken;
    let response: Response;
    try {
      response = await doFetch(`${API_BASE}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
      });
    } catch {
      throw new ApiError(0, "network", "the server could not be reached");
    }
    if (response.status === 204) return undefined as T;
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (data as ApiErrorBody | null)?.error;
      if (response.status === 401 && opts.session !== false) {
        csrfToken = null;
        options.onUnauthorized?.();
      }
      if (error?.code === "two_factor_enrollment_required") options.onEnrollmentRequired?.();
      throw new ApiError(
        response.status,
        error?.code ?? (response.status >= 500 ? "internal" : "invalid_request"),
        error?.message ?? response.statusText,
      );
    }
    return data as T;
  }

  const remember = (s: SessionResponse) => {
    csrfToken = s.csrf_token;
    return s;
  };

  return {
    listCronMonitors: async (id) =>
      (await request<{ monitors: CronMonitor[] }>("GET", projectPath(id, "/cron-monitors"))).monitors,
    createCronMonitor: async (id, body) =>
      (await request<{ monitor: CronMonitor }>("POST", projectPath(id, "/cron-monitors"), { body })).monitor,
    enableCronMonitor: async (id, monitor, enabled) => {
      await request("PATCH", projectPath(id, `/cron-monitors/${segment(monitor)}`), { body: { enabled } });
    },
    listCronRuns: async (id, monitor) =>
      (await request<{ runs: CronRun[] }>("GET", projectPath(id, `/cron-monitors/${segment(monitor)}/runs`))).runs,
    getEmailSettings: () => request<EmailConfiguration>("GET", "/admin/email"),
    saveEmailSettings: (body) => request<EmailConfiguration>("PUT", "/admin/email", { body }),
    testEmail: async (recipient) => {
      await request("POST", "/admin/email/test", { body: { recipient } });
    },
    listNotificationChannels: async (id) =>
      (await request<{ channels: NotificationChannel[] }>("GET", projectPath(id, "/notification-channels"))).channels,
    createNotificationChannel: async (id, body) =>
      (await request<{ channel: NotificationChannel }>("POST", projectPath(id, "/notification-channels"), { body }))
        .channel,
    enableNotificationChannel: async (id, channel, enabled) => {
      await request("PATCH", projectPath(id, `/notification-channels/${segment(channel)}`), { body: { enabled } });
    },
    testNotificationChannel: async (id, channel) => {
      await request("POST", projectPath(id, `/notification-channels/${segment(channel)}/test`));
    },
    listAlertRules: async (id) => (await request<{ rules: AlertRule[] }>("GET", projectPath(id, "/alert-rules"))).rules,
    saveAlertRule: async (id, body, rule) =>
      (
        await request<{ rule: AlertRule }>(
          rule ? "PUT" : "POST",
          projectPath(id, `/alert-rules${rule ? `/${segment(rule)}` : ""}`),
          { body },
        )
      ).rule,
    listNotificationDeliveries: async (id) =>
      (
        await request<{ deliveries: NotificationDelivery[] }>(
          "GET",
          id ? projectPath(id, "/notification-deliveries") : "/admin/email/deliveries",
        )
      ).deliveries,
    setCsrfToken(token) {
      csrfToken = token;
    },
    getSession: () => request<SessionResponse>("GET", "/auth/session", { session: false }).then(remember),
    login: (email, password, code) =>
      request<SessionResponse>("POST", "/auth/login", {
        body: { email, password, ...(code && { code }) },
        session: false,
      }).then(remember),
    getTwoFactor: () => request<TwoFactorStatus>("GET", "/auth/two-factor"),
    setupTwoFactor: (password) => request<TwoFactorSetup>("POST", "/auth/two-factor/setup", { body: { password } }),
    enableTwoFactor: (code) =>
      request<{ recovery_codes: string[] }>("POST", "/auth/two-factor/enable", { body: { code } }),
    disableTwoFactor: (password, code) =>
      request<void>("POST", "/auth/two-factor/disable", { body: { password, code } }),
    regenerateRecoveryCodes: (password, code) =>
      request<{ recovery_codes: string[] }>("POST", "/auth/two-factor/recovery-codes", { body: { password, code } }),
    setTwoFactorPolicy: (required, password, code) =>
      request<{ required: boolean }>("PUT", "/admin/security", { body: { required, password, code } }),
    logout: async () => {
      try {
        await request<void>("POST", "/auth/logout", { session: false });
      } finally {
        csrfToken = null;
      }
    },
    setupRequired: () =>
      request<{ setup_required: boolean }>("GET", "/setup", { session: false }).then(
        (r) => r.setup_required,
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 404) return false;
          throw err;
        },
      ),
    completeSetup: (input) => request<SetupResponse>("POST", "/setup", { body: input, session: false }),
    acceptInvitation: async (token, password) => {
      await request("POST", "/invitations/accept", { body: { token, password }, session: false });
    },
    resetPassword: async (token, password) => {
      await request("POST", "/auth/password-reset", { body: { token, password }, session: false });
    },
    listAudit: (query) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      return request<AuditPage>("GET", `/audit-log?${params}`);
    },
    listAuditActions: () => request<{ actions: string[] }>("GET", "/audit-log/actions").then((r) => r.actions),
    listUsers: () => request<{ users: AccountUser[] }>("GET", "/users").then((r) => r.users),
    updateUser: (userId, change) =>
      request<{ user: AccountUser }>("PATCH", `/users/${segment(userId)}`, { body: change }).then((r) => r.user),
    createPasswordReset: (userId) =>
      request<IssuedPasswordReset>("POST", `/users/${segment(userId)}/password-reset`, { body: {} }).then(
        ({ reset, link }) => ({ reset, link }),
      ),
    listInvitations: () => request<{ invitations: Invitation[] }>("GET", "/invitations").then((r) => r.invitations),
    createInvitation: (email, role) =>
      request<IssuedInvitation>("POST", "/invitations", { body: { email, instance_role: role } }).then(
        ({ invitation, link }) => ({ invitation, link }),
      ),
    revokeInvitation: (id) => request<void>("DELETE", `/invitations/${segment(id)}`),
    listProjects: () => request<{ projects: Project[] }>("GET", "/projects").then((r) => r.projects),
    getProject: (projectId) => request<{ project: Project }>("GET", projectPath(projectId)).then((r) => r.project),
    listMembers: (projectId) =>
      request<{ members: Member[] }>("GET", projectPath(projectId, "/members")).then((r) => r.members),
    addMember: (projectId, email, role) =>
      request<{ member: Member }>("POST", projectPath(projectId, "/members"), { body: { email, role } }).then(
        (r) => r.member,
      ),
    changeMemberRole: (projectId, userId, role) =>
      request<{ member: Member }>("PATCH", projectPath(projectId, `/members/${segment(userId)}`), {
        body: { role },
      }).then((r) => r.member),
    removeMember: (projectId, userId) => request<void>("DELETE", projectPath(projectId, `/members/${segment(userId)}`)),
    listRoles: (projectId) => request<{ roles: Role[] }>("GET", projectPath(projectId, "/roles")).then((r) => r.roles),
    getDatabaseSummary: (projectId, query) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      return request<DatabaseSummary>("GET", projectPath(projectId, `/database/summary?${params}`));
    },
    listEvents: (projectId, query) => {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(query)) if (value !== undefined) params.set(name, String(value));
      return request<EventPage>("GET", projectPath(projectId, `/events?${params}`));
    },
    getEvent: (projectId, eventId) =>
      request<StoredEvent>("GET", projectPath(projectId, `/events/${segment(eventId)}`)),
    getEventSummary: (projectId) => request<EventSummary>("GET", projectPath(projectId, "/events/summary")),
    listIssues: (projectId, query: IssueQuery) => {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(query)) {
        if (value !== undefined) params.set(name, String(value));
      }
      return request<IssuePage>("GET", projectPath(projectId, `/issues?${params}`));
    },
    getIssue: (projectId, issueId) =>
      request<IssueDetail>("GET", projectPath(projectId, `/issues/${segment(issueId)}`)),
    changeIssueStatus: (projectId, issueId, action: IssueAction) =>
      request<{ issue: Issue }>("POST", projectPath(projectId, `/issues/${segment(issueId)}/${action}`)).then(
        (r) => r.issue,
      ),
    listKeys: (projectId) =>
      request<{ keys: IngestionKey[] }>("GET", projectPath(projectId, "/keys")).then((r) => r.keys),
    createKey: (projectId, name) => request<IssuedKey>("POST", projectPath(projectId, "/keys"), { body: { name } }),
    rotateKey: (projectId, keyId) =>
      request<IssuedKey>("POST", projectPath(projectId, `/keys/${segment(keyId)}/rotate`), { body: {} }),
    revokeKey: (projectId, keyId) =>
      request<{ key: IngestionKey }>("POST", projectPath(projectId, `/keys/${segment(keyId)}/revoke`)).then(
        (r) => r.key,
      ),
  };
}
