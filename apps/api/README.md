# API service

Fastify server for setup, sign-in, projects, ingestion keys, event ingestion, and the event query API. It enforces project access at every route and never writes SQL itself; storage goes through `@jekimo/storage-postgres`.

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
| `GET /api/v1/projects` | session | Projects the user belongs to (all, for instance admins). |
| `POST /api/v1/projects` | session + CSRF | Creates a project with built-in roles; the creator becomes its admin. |
| `GET /api/v1/projects/:id` | session, `project.read` | One project. |
| `POST /api/v1/projects/:id/keys` | session + CSRF, `keys.manage` | Creates an ingestion key and returns it once. |
| `GET /api/v1/projects/:id/events` | session, `project.read` | Events, newest first, by `from`, `to` (RFC 3339, on `received_at`), `severity` and `kind` (comma lists), `environment`, `release`, and `fingerprint` (exact match), `q` (words of the message), `limit` (1 to 500), and `cursor`. |
| `GET /api/v1/projects/:id/events/:event_id` | session, `project.read` | One event. `404` when the id is unknown or belongs to another project. |
| `POST /api/v1/ingest` | ingestion key | [Ingestion protocol v1](../../docs/ingestion-protocol.md). |

State-changing session requests need the `X-Jekimo-CSRF-Token` header. Session routes reject any `Authorization` header, so an ingestion key is never accepted there, and the ingest route ignores cookies. Projects the user cannot access answer `404`.

Not yet implemented: rate limits and quotas (a TODO in `src/routes/ingest.ts` cites the protocol), invitations, password reset, key rotation and revocation endpoints, and custom role management.

## Development

```bash
npm run dev -w @jekimo/api     # tsx watch, needs JEKIMO_DATABASE_URL
npm run build -w @jekimo/api   # dist/main.mjs and dist/migrate.mjs
npm test -- apps/api
```

The container image is built from the repository root with `docker build -f apps/api/Dockerfile .`; see [docs/local-development.md](../../docs/local-development.md). Settings are in [docs/configuration.md](../../docs/configuration.md).
