# API service

Fastify server for setup, sign-in, accounts and invitations, projects and memberships, ingestion keys, the audit log, event ingestion, and the event query API. It enforces project access at every route and never writes SQL itself; storage goes through `@jekimo/storage-postgres`.

Fastify was chosen over Hono because it is Node-native and mature, gives per-route body parsers and encapsulated plugins (the ingest endpoint has its own parser, error format, and no session middleware), ships structured logging with redaction, and has `inject()` for tests without a socket.

## Endpoints

| Method and path | Credential | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | Liveness: the process is up. Touches no dependency. |
| `GET /readyz` | none | Readiness: the database and the queue answer within 2 seconds; `503` with `error.code` `not_ready` otherwise. |
| `GET /api/v1/setup` | none | `{"setup_required": true}` while setup is open; `404` once it has completed. |
| `POST /api/v1/setup` | setup token printed at start | Creates the first instance admin, the first project, and its ingestion key (returned once). `404` once setup has completed. |
| `POST /api/v1/auth/login` | email and password | Starts a session (cookie) and returns a CSRF token. |
| `GET /api/v1/auth/session` | session | Current user and CSRF token. |
| `POST /api/v1/auth/logout` | session + CSRF | Ends the session. |
| `POST /api/v1/auth/password` | session + CSRF | Changes the password (`current_password`, `new_password`) and revokes the user's other sessions. `403 invalid_credentials` for a wrong current password. |
| `GET /api/v1/auth/sessions` | session | The user's live sessions, with `current: true` on this one. |
| `DELETE /api/v1/auth/sessions/:session_id` | session + CSRF | Revokes one of the user's own sessions. |
| `POST /api/v1/auth/password-reset` | reset token | Sets a new password (`token`, `password`) from a reset link and revokes every session of the user. `400 invalid_token` for an unknown, used, revoked, or expired link. |
| `POST /api/v1/invitations/accept` | invitation token | Creates the invited user with a password (`token`, `password`). `400 invalid_token` as above, `409 email_taken`. |
| `GET /api/v1/users` | session, instance admin | Every user, with instance role and status. |
| `PATCH /api/v1/users/:user_id` | session + CSRF, instance admin | Changes `instance_role` (`admin`, `member`) or `status` (`active`, `deactivated`). Deactivating revokes the user's sessions. `409 last_admin` when it would leave no active instance admin. |
| `DELETE /api/v1/users/:user_id/sessions` | session + CSRF, instance admin | Revokes every session of a user; returns `{"revoked": n}`. |
| `POST /api/v1/users/:user_id/password-reset` | session + CSRF, instance admin | Returns a single-use reset `token` and `link`, once. Replaces any earlier unused link for the user. |
| `POST /api/v1/invitations` | session + CSRF, instance admin | Invites `email` with an `instance_role` (default `member`). Returns the invitation and a single-use `token` and `link`, once. Replaces any pending invitation for the email; `409 email_taken` when the email has an account. |
| `GET /api/v1/invitations` | session, instance admin | Pending invitations, without tokens. |
| `DELETE /api/v1/invitations/:invitation_id` | session + CSRF, instance admin | Revokes a pending invitation. |
| `GET /api/v1/audit-log` | session, instance admin | Audit entries, newest first, filtered by `actor` (user id), `action`, `from` and `to` (RFC 3339 on the entry time), with `limit` (1 to 500, default 100) and `cursor` (the previous page's `next_cursor`). |
| `GET /api/v1/projects` | session | Projects the user belongs to (all, for instance admins). |
| `POST /api/v1/projects` | session + CSRF | Creates a project with built-in roles; the creator becomes its admin. |
| `GET /api/v1/projects/:id` | session, `project.read` | One project. |
| `PATCH /api/v1/projects/:id` | session + CSRF, `settings.manage` | Changes `name`, `retention_days`, or `sample_rate`; audit-logged with before and after values. |
| `GET /api/v1/projects/:id/roles` | session, `project.read` | The project's roles with their permissions and member counts. |
| `GET /api/v1/projects/:id/members` | session, `project.read` | The project's members and their roles. |
| `POST /api/v1/projects/:id/members` | session + CSRF, `members.manage` | Adds an instance user by `email` or `user_id` with a `role` name. |
| `PATCH /api/v1/projects/:id/members/:user_id` | session + CSRF, `members.manage` | Changes a member's `role`. |
| `DELETE /api/v1/projects/:id/members/:user_id` | session + CSRF, `members.manage` | Removes a member. |
| `POST /api/v1/projects/:id/keys` | session + CSRF, `keys.manage` | Creates an ingestion key and returns it once. |
| `GET /api/v1/projects/:id/keys` | session, `keys.manage` | The project's keys by `key_id`, with name, creation time, and `status` (`active`, `rotating`, `expired`, `revoked`). Never the key or its hash. |
| `POST /api/v1/projects/:id/keys/:key_id/rotate` | session + CSRF, `keys.manage` | Returns a new key once, with the old key's name. The old key keeps working for `grace_hours` (0 to 720, default `JEKIMO_KEY_ROTATION_GRACE_HOURS`). Only `active` keys can be rotated (`409 key_not_active`). |
| `POST /api/v1/projects/:id/keys/:key_id/revoke` | session + CSRF, `keys.manage` | Revokes a key; the next ingest request with it gets `401`. `409 key_already_revoked`. |
| `GET /api/v1/projects/:id/events` | session, `project.read` | Events, newest first, by `from`, `to` (RFC 3339, on `received_at`), `severity` and `kind` (comma lists), `environment`, `release`, and `fingerprint` (exact match), `q` (words of the message), `limit` (1 to 500), and `cursor`. |
| `GET /api/v1/projects/:id/events/:event_id` | session, `project.read` | One event. `404` when the id is unknown or belongs to another project. |
| `POST /api/v1/ingest` | ingestion key | [Ingestion protocol v1](../../docs/ingestion-protocol.md). |

State-changing session requests need the `X-Jekimo-CSRF-Token` header. Every route except ingest and the health checks rejects any `Authorization` header with `401`, so an ingestion key is never accepted there, and the ingest route ignores cookies. Projects the user cannot access answer `404`.

Membership rules, enforced in the storage layer in the same transaction as the change:

- **No escalation.** Adding a member or changing their role needs `members.manage` and every permission of the role being granted (`canAssignRole`). Changing or removing a member also needs every permission of their current role, so a member manager cannot demote or remove someone with more permissions. Otherwise `403 role_escalation`.
- **Last admin.** A project keeps at least one member with the built-in `admin` role: demoting or removing the last one answers `409 last_admin`. An instance admin can do it on purpose with `?force=true`; the audit entry then carries `last_admin_removed: true`. `force` from anyone else is `403`.
- Other codes: `404 user_not_found`, `409 already_member`, `400 unknown_role`, `404 member_not_found`. Role names match case-insensitively.

Invitation and reset links have the form `<JEKIMO_PUBLIC_URL>/invite#token=<token>` and `<JEKIMO_PUBLIC_URL>/reset-password#token=<token>` (a path when `JEKIMO_PUBLIC_URL` is unset). The token travels in the fragment, so browsers do not send it to servers or proxies. Until the dashboard serves those pages, post the token to the API routes above. Links expire after `JEKIMO_INVITE_EXPIRY_DAYS` and work once; only their SHA-256 is stored.

Every sensitive action calls the audit writer (`AUDIT_ACTIONS` in `@jekimo/storage-postgres` lists them). Entries record the actor, action, target, time, source IP, and whether instance-admin authority was used, and never passwords, keys, session tokens, or event payloads.

Not yet implemented: rate limits and quotas (a TODO in `src/routes/ingest.ts` cites the protocol), custom role management, project deletion and restore, and emailing links over SMTP.

## Development

```bash
npm run dev -w @jekimo/api     # tsx watch, needs JEKIMO_DATABASE_URL
npm run build -w @jekimo/api   # dist/main.mjs, dist/cli.mjs, and dist/migrate.mjs
npm test -- apps/api
```

### Operator command

`jekimo admin reset-password <email>` prints a single-use password reset link for a user; it is how an instance admin recovers their own account ([docs/access-model.md](../../docs/access-model.md), "Invitations and recovery without email"). It reads the same environment as the API. In the container image it is on the `PATH`:

```bash
docker compose exec api jekimo admin reset-password admin@example.test
```

From a checkout, use `npm run cli -w @jekimo/api -- admin reset-password <email>`, or `node dist/cli.mjs admin reset-password <email>` after a build. The command is audit-logged with no actor and `via: "cli"`.

The container image is built from the repository root with `docker build -f apps/api/Dockerfile .`; see [docs/local-development.md](../../docs/local-development.md). Settings are in [docs/configuration.md](../../docs/configuration.md).
