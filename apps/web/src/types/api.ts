import type { EventEnvelope, EventKind, Severity } from "@jekimo/event-schema";
import type { ProjectPermission } from "@jekimo/event-schema/constants";
import type { IssueAction, IssueStatus } from "../constants/issues";

/** Response shapes of the API; see apps/api/README.md. */

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export interface User {
  id: string;
  email: string;
  instance_role: "admin" | "member";
  created_at: string;
}

export interface SessionResponse {
  user: User;
  csrf_token: string;
  expires_at?: string;
}

export interface Project {
  id: string;
  name: string;
  retention_days: number;
  sample_rate: number;
  disabled: boolean;
  created_at: string;
}

export interface Member {
  user_id: string;
  email: string;
  status: string;
  role: string;
  created_at: string;
}

export interface Role {
  name: string;
  description: string | null;
  permissions: ProjectPermission[];
  built_in: boolean;
  member_count: number;
}

export interface Issue {
  id: string;
  fingerprint: string;
  title: string;
  kind: EventKind;
  status: IssueStatus;
  last_severity: Severity;
  event_count: number;
  first_seen: string;
  last_seen: string;
  environments: string[];
  last_event_id?: string;
  status_changed_at?: string;
}

export interface IssuePage {
  issues: Issue[];
  next_cursor?: string;
}

export interface StoredEvent {
  received_at: string;
  key_id: string;
  skew_ms?: number;
  event: EventEnvelope;
}

export interface IssueDetail {
  issue: Issue;
  latest_event: StoredEvent | null;
}

export type KeyStatus = "active" | "rotating" | "expired" | "revoked";

export interface IngestionKey {
  key_id: string;
  name: string;
  status: KeyStatus;
  created_at: string;
  created_by: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/** A newly created or rotated key. `key` is the secret: shown once, never cached. */
export interface IssuedKey {
  key_id: string;
  key: string;
  name: string;
  created_at: string;
  rotated?: IngestionKey;
}

export interface SetupInput {
  setup_token: string;
  email: string;
  password: string;
  project_name: string;
}

export interface SetupResponse {
  user: User;
  project: Project;
  ingestion_key: IssuedKey;
}

export interface IssueQuery {
  status?: string;
  kind?: string;
  severity?: string;
  from?: string;
  cursor?: string;
  limit: number;
}

export interface Api {
  getSession(): Promise<SessionResponse>;
  login(email: string, password: string): Promise<SessionResponse>;
  logout(): Promise<void>;
  setupRequired(): Promise<boolean>;
  completeSetup(input: SetupInput): Promise<SetupResponse>;
  acceptInvitation(token: string, password: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<void>;
  listProjects(): Promise<Project[]>;
  getProject(projectId: string): Promise<Project>;
  listMembers(projectId: string): Promise<Member[]>;
  listRoles(projectId: string): Promise<Role[]>;
  listIssues(projectId: string, query: IssueQuery): Promise<IssuePage>;
  getIssue(projectId: string, issueId: string): Promise<IssueDetail>;
  changeIssueStatus(projectId: string, issueId: string, action: IssueAction): Promise<Issue>;
  listKeys(projectId: string): Promise<IngestionKey[]>;
  createKey(projectId: string, name: string): Promise<IssuedKey>;
  rotateKey(projectId: string, keyId: string): Promise<IssuedKey>;
  revokeKey(projectId: string, keyId: string): Promise<IngestionKey>;
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  /** Called when a signed-in request answers 401: the session ended or expired. */
  onUnauthorized?: () => void;
}

export interface RequestOptions {
  body?: unknown;
  /** False for requests made without a session (sign-in, setup, links), whose 401 is an answer, not an expiry. */
  session?: boolean;
}
