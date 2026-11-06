# Access model

This document specifies who can do what in a Jekimo instance: how people sign in, how projects are owned and shared, and how project isolation is enforced. It is normative for `apps/api`, `apps/web`, and `packages/storage-postgres`.

Key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as in RFC 2119.

Status: draft.

## Goals

- One operator installs one instance and invites the people who need it. There is no public sign-up and no hosted account.
- A user sees only the projects they are a member of. Nothing about other projects leaks, including their existence.
- Project credentials for machines (ingestion keys) and credentials for people (user sessions) are separate systems that can never substitute for each other.
- Every privileged action is attributable to a person and recorded.

## Concepts

| Concept | Meaning |
| --- | --- |
| **Instance** | One Jekimo installation on one VPS, with one database. |
| **User** | A person with an email address and a password. Users are instance-wide. |
| **Instance role** | `admin` or `member`. Every user has exactly one. |
| **Project** | An isolated container of events, issues, settings, ingestion keys, and memberships. |
| **Membership** | Links one user to one project with one project role. |
| **Project role** | `admin`, `member`, or `viewer`. |
| **Ingestion key** | A project credential for SDKs. Not a user; grants nothing beyond `POST /api/v1/ingest`. See the [ingestion protocol](ingestion-protocol.md). |

## Instance roles

| Capability | `admin` | `member` |
| --- | --- | --- |
| Sign in and use projects they are a member of | Yes | Yes |
| Create projects | Yes | Configurable: `JEKIMO_MEMBERS_CAN_CREATE_PROJECTS`, default `true` |
| See and manage every project, including ones they are not a member of | Yes | No |
| Invite, deactivate, and reactivate users; change instance roles | Yes | No |
| Set instance settings: retention bounds, quotas, disk thresholds, SMTP | Yes | No |
| View the instance audit log | Yes | No |
| Restore a project within its deletion grace period | Yes | No |

- The first user, created during setup, is an instance `admin`. An instance MUST always have at least one active admin; the last one cannot be demoted or deactivated.
- Instance admins act on projects with implicit project `admin` rights. Those actions are audit-logged with a flag showing they were performed through instance authority rather than membership.

## Project roles

| Capability | `admin` | `member` | `viewer` |
| --- | --- | --- | --- |
| View events, issues, and search | Yes | Yes | Yes |
| Resolve, ignore, reopen, and comment on issues | Yes | Yes | No |
| Export project data | Yes | Yes | No |
| Delete issues or events by filter | Yes | No | No |
| Create, rotate, and revoke ingestion keys | Yes | No | No |
| Change project settings: name, environments, retention, sample rate, redaction rules | Yes | No | No |
| Manage members and their roles | Yes | No | No |
| Delete the project | Yes | No | No |

- The user who creates a project becomes its `admin`.
- A project MUST always have at least one `admin` member, unless an instance admin is removing the last one on purpose, in which case the dashboard warns that only instance admins will be able to manage it.
- Roles are per project. The same user can be `admin` on one project and `viewer` on another.

## Authentication

### Passwords

- Email plus password. Passwords are hashed with Argon2id using parameters at or above the OWASP current minimums, and never logged or stored in any other form.
- Minimum length 12 characters, maximum 128, no composition rules. Passwords MUST be checked against a breached-password list when one is bundled or configured.
- Account lockout: after 10 failed attempts in 15 minutes, further attempts are rejected for 15 minutes. Lockouts are audit-logged. The response for a locked account is identical to a wrong password.

### Sessions

- Server-side sessions identified by a random 256-bit token in a cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`.
- Idle timeout 14 days, absolute lifetime 30 days, both operator-adjustable. Changing a password revokes all other sessions of that user.
- State-changing requests from the dashboard carry a CSRF token in a header; the API rejects cookie-authenticated state changes without it.
- Users can see and revoke their own sessions. Instance admins can revoke any user's sessions.

### Invitations and recovery without email

The MVP MUST work on a VPS with no outgoing email.

- An instance admin creates an invitation and receives a single-use link to hand to the person. The link expires in 7 days. The invitee sets their password on first visit.
- Password reset works the same way: an instance admin generates a single-use reset link for the user. When SMTP is configured, the instance MAY email invitations and reset links instead.
- Instance admins recover their own account with the CLI on the VPS (`jekimo admin reset-password <email>`), which prints a reset link. There is no other back door.

### Two-factor authentication

TOTP second factor is planned as an additive change. The data model reserves room for it; it is not in the first release.

### API tokens for people

Personal API tokens for the query and export API are planned. They will be scoped to a subset of the user's projects and roles, revocable, and shown once. Until they exist, the query API accepts session cookies only. Ingestion keys MUST NOT be accepted by the query API under any circumstances.

## Authorization enforcement

This is the implementation of rule 1 in `AGENTS.md`: project isolation is a hard requirement.

1. **The storage layer takes `project_id` as a mandatory parameter** on every read and write of project data. There is no function that reads events across projects. The only cross-project queries are membership lookups and instance-admin listings, and they live in separate modules.
2. **The API resolves the project from the URL and checks membership before anything else.** A request for a project the user cannot access returns `404`, not `403`, so the response does not reveal whether the project exists. The one exception is instance admins, who get `200`.
3. **Role checks are declared per route**, not scattered in handlers, and tested with a matrix of every role against every route.
4. **Exports and searches are scoped at the query**, not filtered afterwards.
5. **Ingestion keys cannot reach any endpoint except ingest.** The ingest endpoint cannot be reached with a session cookie. Each credential type has its own middleware; neither falls through to the other.
6. **The dashboard never trusts a project id from the client** for anything but routing. The server re-derives access on every request.

## Audit log

Instance-wide, append-only, visible to instance admins, retained per [retention.md](retention.md).

Recorded events include:

- Sign-in success and failure, lockout, sign-out, session revocation, password change.
- User invited, activated, deactivated, role changed.
- Project created, settings changed, deleted, restored.
- Membership added, role changed, removed.
- Ingestion key created, rotated, revoked.
- Retention, quota, or sample rate changed.
- Bulk deletion of events or issues.
- Instance settings changed.

Each entry records the actor, the action, the target, the time, the source IP, and whether instance-admin authority was used. Entries never contain passwords, keys, session tokens, or event payloads.

## Setup flow

1. The installer starts the services and opens a one-time setup page protected by a token printed to the console.
2. The operator creates the first instance admin.
3. The operator chooses the database option (existing or local) as described in the README. Administrator database credentials used here are discarded after setup.
4. The operator creates the first project and receives its ingestion key, shown once.

## Planned configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEKIMO_MEMBERS_CAN_CREATE_PROJECTS` | `true` | Whether instance members may create projects |
| `JEKIMO_SESSION_IDLE_DAYS` | `14` | Session idle timeout |
| `JEKIMO_SESSION_MAX_DAYS` | `30` | Session absolute lifetime |
| `JEKIMO_INVITE_EXPIRY_DAYS` | `7` | Invitation and reset link lifetime |
| `JEKIMO_SMTP_URL` | unset | When set, invitations and resets are emailed |

## Open questions

- Teams or groups as a way to grant many users access to many projects at once.
- Single sign-on (OIDC) for organisations that require it.
- Whether `viewer` should be allowed to export.
