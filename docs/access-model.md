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
| **Membership** | Links one user to one project with one role. |
| **Permission** | A stable identifier for one capability inside a project, such as `keys.manage`. |
| **Role** | A named set of permissions within a project. Three built-in roles (`admin`, `member`, `viewer`) exist in every project; custom roles can be added. |
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
- Instance admins hold every project permission in every project implicitly. Those actions are audit-logged with a flag showing they were performed through instance authority rather than membership.

## Project permissions and roles

Access inside a project is **permission-based**. A role is a named set of permissions. Every project is created with three built-in roles, and anyone holding the `roles.manage` permission can add custom roles for that project.

### Permission catalogue

Permission identifiers are stable strings. Reference list: `PROJECT_PERMISSIONS` in `packages/event-schema/src/permissions.ts`.

| Permission | Grants |
| --- | --- |
| `project.read` | View events, issues, search, and project settings. Every role MUST include it. |
| `issues.manage` | Resolve, ignore, reopen, and comment on issues. |
| `data.export` | Export project data. |
| `data.delete` | Delete issues, or events by filter. |
| `keys.manage` | Create, rotate, and revoke ingestion keys. |
| `settings.manage` | Change project settings: name, environments, retention, sample rate, redaction rules. |
| `members.manage` | Add and remove members and assign them roles. |
| `roles.manage` | Create, edit, and delete custom roles in the project. |
| `project.delete` | Delete the project. |

### Built-in roles

Created with every project. They cannot be renamed, edited, or deleted, so documentation and support can rely on them. The test suite checks that this table and `DEFAULT_PROJECT_ROLES` in the code agree.

| Permission | `admin` | `member` | `viewer` |
| --- | --- | --- | --- |
| `project.read` | Yes | Yes | Yes |
| `issues.manage` | Yes | Yes | No |
| `data.export` | Yes | Yes | No |
| `data.delete` | Yes | No | No |
| `keys.manage` | Yes | No | No |
| `settings.manage` | Yes | No | No |
| `members.manage` | Yes | No | No |
| `roles.manage` | Yes | No | No |
| `project.delete` | Yes | No | No |

`admin` always holds every permission, including any added in a future release.

### Custom roles

- A custom role belongs to one project and has a name (1 to 40 characters, unique within the project, case-insensitive, and not one of the built-in names), an optional description, and a set of permissions that MUST include `project.read`.
- **No escalation:** a user can only grant permissions they hold themselves. Creating or editing a role with a permission the actor lacks is rejected, and so is assigning such a role to anyone, including themselves.
- Editing a custom role changes what its current holders can do immediately. The dashboard shows how many members hold the role before the change is saved.
- A custom role with members cannot be deleted; members are reassigned first.
- Role changes are audit-logged with the before and after permission sets.

### Membership rules

- The user who creates a project receives the built-in `admin` role.
- A project MUST always have at least one member with the built-in `admin` role, unless an instance admin is removing the last one on purpose, in which case the dashboard warns that only instance admins will be able to manage it.
- A user has exactly one role per project. The same user can be `admin` on one project and a custom role on another.
- Instance admins hold every project permission implicitly; see "Instance roles".

### Adding permissions in a future release

Adding a permission is an additive change. The built-in `admin` role gains it automatically; `member`, `viewer`, and custom roles do not, and the release notes say which roles should be reviewed. Removing or renaming a permission is a breaking change and requires a migration that maps old identifiers to new ones.

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

Personal API tokens for the query and export API are planned. They will be scoped to a subset of the user's projects and permissions, revocable, and shown once. Until they exist, the query API accepts session cookies only. Ingestion keys MUST NOT be accepted by the query API under any circumstances.

## Authorization enforcement

This is the implementation of rule 1 in `AGENTS.md`: project isolation is a hard requirement.

1. **The storage layer takes `project_id` as a mandatory parameter** on every read and write of project data. There is no function that reads events across projects. The only cross-project queries are membership lookups and instance-admin listings, and they live in separate modules.
2. **The API resolves the project from the URL and checks membership before anything else.** A request for a project the user cannot access returns `404`, not `403`, so the response does not reveal whether the project exists. The one exception is instance admins, who get `200`.
3. **Permission checks are declared per route** as the permission the route requires, not scattered in handlers, and tested with a matrix of every built-in role, a custom role with each single permission, and the instance admin against every route.
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
- Custom role created, edited (with before and after permissions), deleted.
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
