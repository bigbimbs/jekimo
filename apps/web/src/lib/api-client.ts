import { API_BASE, CSRF_HEADER } from "../constants/api";
import type { IssueAction } from "../constants/issues";
import type {
  Api,
  ApiClientOptions,
  ApiErrorBody,
  IngestionKey,
  Issue,
  IssueDetail,
  IssuedKey,
  IssuePage,
  IssueQuery,
  Member,
  Project,
  RequestOptions,
  Role,
  SessionResponse,
  SetupResponse,
} from "../types/api";

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
    setCsrfToken(token) {
      csrfToken = token;
    },
    getSession: () => request<SessionResponse>("GET", "/auth/session", { session: false }).then(remember),
    login: (email, password) =>
      request<SessionResponse>("POST", "/auth/login", { body: { email, password }, session: false }).then(remember),
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
    listProjects: () => request<{ projects: Project[] }>("GET", "/projects").then((r) => r.projects),
    getProject: (projectId) => request<{ project: Project }>("GET", projectPath(projectId)).then((r) => r.project),
    listMembers: (projectId) =>
      request<{ members: Member[] }>("GET", projectPath(projectId, "/members")).then((r) => r.members),
    listRoles: (projectId) => request<{ roles: Role[] }>("GET", projectPath(projectId, "/roles")).then((r) => r.roles),
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
