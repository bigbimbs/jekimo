import type { EventEnvelope, EventKind, Severity } from "@jekimo/event-schema";
import type { ProjectPermission } from "@jekimo/event-schema/constants";
import type { IssueAction, IssueStatus } from "../constants/issues";
import type { CronApi } from "./cron";
import type { DatabaseFilter, DatabaseSummary } from "./database";
import type { NotificationApi } from "./notifications";

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

export interface AccountUser extends User {
  status: "active" | "deactivated";
}

export interface UserChange {
  instance_role?: User["instance_role"];
  status?: AccountUser["status"];
}

export interface Invitation {
  id: string;
  email: string;
  instance_role: User["instance_role"];
  created_by: string;
  created_at: string;
  expires_at: string;
}

export interface IssuedInvitation {
  invitation: Invitation;
  link: string;
}

export interface IssuedPasswordReset {
  reset: { id: string; user_id: string; created_at: string; expires_at: string };
  link: string;
}

export interface TwoFactorStatus {
  enabled: boolean;
  required: boolean;
  configured: boolean;
  recovery_codes_remaining: number;
}

export interface TwoFactorSetup {
  secret: string;
  otpauth_uri: string;
  expires_at: string;
}

export interface SessionResponse {
  two_factor?: { enabled: boolean; required: boolean };
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

export interface EventQuery {
  database?: boolean;
  kind?: "log" | "event";
  trace_id?: string;
  severity?: string;
  environment?: string;
  q?: string;
  from: string;
  to: string;
  limit: number;
  cursor?: string;
}

export interface EventPage {
  events: StoredEvent[];
  next_cursor?: string;
}

export interface EventSummary {
  from: string;
  to: string;
  activity: { hour: string; kind: EventKind; severity: Severity; count: number }[];
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

export interface AuditEntry {
  id: string;
  occurred_at: string;
  actor: { user_id: string; email: string | null } | null;
  action: string;
  target: { type: string; id: string | null } | null;
  project_id: string | null;
  source_ip: string | null;
  via_instance_admin: boolean;
  details: Record<string, unknown>;
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  next_cursor?: string;
}

export interface Api extends NotificationApi, CronApi {
  getDatabaseSummary(projectId: string, query: DatabaseFilter): Promise<DatabaseSummary>;
  listEvents(projectId: string, query: EventQuery): Promise<EventPage>;
  getEvent(projectId: string, eventId: string): Promise<StoredEvent>;
  getEventSummary(projectId: string): Promise<EventSummary>;
  listAudit(query: AuditQuery): Promise<AuditPage>;
  listAuditActions(): Promise<string[]>;
  listUsers(): Promise<AccountUser[]>;
  updateUser(userId: string, change: UserChange): Promise<AccountUser>;
  createPasswordReset(userId: string): Promise<IssuedPasswordReset>;
  listInvitations(): Promise<Invitation[]>;
  createInvitation(email: string, role: User["instance_role"]): Promise<IssuedInvitation>;
  revokeInvitation(invitationId: string): Promise<void>;
  getSession(): Promise<SessionResponse>;
  getTwoFactor(): Promise<TwoFactorStatus>;
  setupTwoFactor(password: string): Promise<TwoFactorSetup>;
  enableTwoFactor(code: string): Promise<{ recovery_codes: string[] }>;
  disableTwoFactor(password: string, code: string): Promise<void>;
  regenerateRecoveryCodes(password: string, code: string): Promise<{ recovery_codes: string[] }>;
  setTwoFactorPolicy(required: boolean, password: string, code: string): Promise<{ required: boolean }>;
  login(email: string, password: string, code?: string): Promise<SessionResponse>;
  logout(): Promise<void>;
  setupRequired(): Promise<boolean>;
  completeSetup(input: SetupInput): Promise<SetupResponse>;
  acceptInvitation(token: string, password: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<void>;
  listProjects(): Promise<Project[]>;
  getProject(projectId: string): Promise<Project>;
  listMembers(projectId: string): Promise<Member[]>;
  addMember(projectId: string, email: string, role: string): Promise<Member>;
  changeMemberRole(projectId: string, userId: string, role: string): Promise<Member>;
  removeMember(projectId: string, userId: string): Promise<void>;
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
  onEnrollmentRequired?: () => void;
}

export interface RequestOptions {
  body?: unknown;
  /** False for requests made without a session (sign-in, setup, links), whose 401 is an answer, not an expiry. */
  session?: boolean;
}
