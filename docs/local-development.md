# Local development

This walkthrough runs the whole vertical slice on one machine: PostgreSQL, the API, the worker, and the dashboard in Docker Compose, then setup, a project, an ingestion key, one event sent with curl, and the same event read back. Everything here uses synthetic data.

You need Docker with Compose v2, curl, [jq](https://jqlang.org/), and Node.js 22 (only for running tests and the services outside Docker). Run every command from the repository root.

## 1. Start the stack

```bash
cp .env.example .env
```

```bash
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml up -d --build
```

This starts five services:

| Service | What it does |
| --- | --- |
| `postgres` | PostgreSQL 16 on `127.0.0.1:5432` (`JEKIMO_DEV_POSTGRES_PORT` to change it). |
| `migrate` | Applies `packages/storage-postgres/migrations/*.sql` and creates event partitions for the coming week, then exits. |
| `api` | The API on `127.0.0.1:8080` (`JEKIMO_DEV_API_PORT` to change it). Starts after `migrate` succeeds. |
| `worker` | Drains the ingest queue and runs the expiry pass. Starts after `migrate` succeeds. |
| `web` | The dashboard on `http://localhost:8081` (`JEKIMO_DEV_WEB_PORT` to change it), proxying `/api` to the `api` service. |

If port 5432 is already taken by a local PostgreSQL, set `JEKIMO_DEV_POSTGRES_PORT=55432` in `.env` and use the same port in `JEKIMO_DATABASE_URL`.

Check that everything is up:

```bash
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml ps -a
```

`migrate` shows `Exited (0)`, `api` shows `healthy` (its container health check calls `/readyz`), and:

```bash
curl -s http://127.0.0.1:8080/readyz
```

```json
{"status":"ok","checks":{"database":"ok","queue":"ok"}}
```

`GET /readyz` answers `503` with `{"status":"unavailable","checks":{...},"error":{"code":"not_ready",...}}` naming the unreachable dependency while PostgreSQL or the queue table cannot be reached. `GET /healthz` only reports that the API process is up and never touches the database.

### The dashboard

Open <http://localhost:8081>. The session cookie is `Secure`, which browsers accept over plain HTTP only from `localhost`; Chrome also accepts `127.0.0.1`, other browsers may not. On a fresh database the dashboard opens its setup page; paste the setup token from step 3 below and choose the first admin's email, password, and project name. It shows the project's ingestion key once, with a copy button, then signs you in. The rest of this walkthrough uses `curl` so every API call is visible; the dashboard shows the same data under **Issues**, and the project's keys under **Settings**.

## 2. Migrate

Migrations already ran as the `migrate` service. To run them again after adding a migration:

```bash
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml run --rm migrate
```

Or from your machine, against the published port:

```bash
set -a; . ./.env; set +a; npm run migrate -w @jekimo/storage-postgres
```

Each migration is applied once and recorded in `schema_migrations`. To have the API and worker apply pending migrations themselves when they start, set `JEKIMO_MIGRATE_ON_START=true` ([configuration.md](configuration.md#database)); the `migrate` service keeps working either way.

## 3. Run setup

On first start, with no users in the database, the API prints a one-time setup token to its console:

```bash
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml logs api | grep -A2 "setup token"
```

The token is valid until setup completes or the API restarts. Setup creates the first instance admin, the first project, and that project's first ingestion key in one request (the password needs 12 to 128 characters, the project name 1 to 128):

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/setup \
  -H 'content-type: application/json' \
  -d '{"setup_token":"<token from the api logs>","email":"admin@example.test","password":"synthetic-password-123","project_name":"Billing API"}'
```

```json
{"user":{"id":"57d867a7-12ad-4cb6-8f17-4ca00904a91a","email":"admin@example.test","instance_role":"admin","created_at":"2026-11-06T14:06:21.528Z"},"project":{"id":"prj_isdkxqf9vy94reeg","name":"Billing API","retention_days":30,"sample_rate":1,"disabled":false,"created_at":"2026-11-06T14:06:21.656Z"},"ingestion_key":{"key_id":"ZEDH3RB37RV1","key":"jk_ZEDH3RB37RV1_<secret, shown once>","name":"setup","created_at":"2026-11-06T14:06:21.694Z"},"notice":"The ingestion key is shown once. Store it in your secret manager now."}
```

The full key is returned only here. The database keeps `key_id` and a SHA-256 hash of the key; the logs and the audit log (`ingestion_key.created`) record the `key_id` only.

```bash
PROJECT_ID='<project id from the response>'
JEKIMO_KEY='<key from the response>'
```

Once setup has succeeded, `GET` and `POST /api/v1/setup` answer `404 not_found`, and the token no longer works. They also answer `404` on an API started against a database that already has users.

## 4. Sign in

```bash
curl -s -c cookies.txt -X POST http://127.0.0.1:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.test","password":"synthetic-password-123"}'
```

```json
{"user":{"id":"57d867a7-12ad-4cb6-8f17-4ca00904a91a","email":"admin@example.test","instance_role":"admin","created_at":"2026-11-06T14:06:21.528Z"},"csrf_token":"<csrf token>"}
```

The session lives in the `jekimo_session` cookie (`HttpOnly`, `Secure`, `SameSite=Lax`) that curl saved to `cookies.txt`. State-changing requests also need the CSRF token from the response:

```bash
CSRF='<csrf_token from the response>'
```

## 5. More projects and keys (optional)

Create another project and a key for it with the session:

```bash
curl -s -b cookies.txt -X POST http://127.0.0.1:8080/api/v1/projects \
  -H "x-jekimo-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"Checkout"}'
```

```bash
curl -s -b cookies.txt -X POST "http://127.0.0.1:8080/api/v1/projects/<project id>/keys" \
  -H "x-jekimo-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"local"}'
```

```json
{"key_id":"Q7M2K9V4T1XH","key":"jk_Q7M2K9V4T1XH_<secret, shown once>","name":"local","created_at":"2026-11-06T14:07:02.113Z","notice":"This key is shown once. Store it in your secret manager now."}
```

The rest of this walkthrough uses the project and key from setup.

## 6. Send events

Build a batch from the synthetic examples in [`packages/event-schema/examples/`](../packages/event-schema/examples/). They are in stored form, so the `project_id` the server assigns is removed first. The batch holds the exception example, with a `password` attribute added to show redaction, and the log example with its required `message` removed, to show a rejection:

```bash
jq -n \
  --slurpfile exception packages/event-schema/examples/exception.json \
  --slurpfile log packages/event-schema/examples/log.json \
  --arg sent_at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  '{
    sent_at: $sent_at,
    events: [
      ($exception[0] | del(.project_id) | .attributes.password = "synthetic"),
      ($log[0] | del(.project_id, .message))
    ]
  }' > events.json
```

```bash
curl -s -i -X POST http://127.0.0.1:8080/api/v1/ingest \
  -H "authorization: Bearer $JEKIMO_KEY" -H 'content-type: application/json' \
  -d @events.json
```

```text
HTTP/1.1 202 Accepted
x-jekimo-request-id: 4ce12438-b03c-4ae7-86e8-937b750a92af
content-type: application/json; charset=utf-8

{"accepted":["01JBQ4Z3H8X9T2K7M5N6P8R9SV"],"rejected":[{"index":1,"errors":[{"path":"/message","code":"required","message":"/message is required"}],"event_id":"01JBQ50A6D2V8W4Y1Z3X5C7B9N"}]}
```

`202` means the accepted event is in the durable queue. Sending the same file again returns the same `accepted` list and stores nothing new: the repeat goes through the queue again, and the worker drops it when it appends to the event store, because events are deduplicated on `(project_id, event_id)` for at least 7 days.

## 7. Read it back

The worker stores the event within a second or two:

```bash
curl -s -b cookies.txt "http://127.0.0.1:8080/api/v1/projects/$PROJECT_ID/events?severity=error,fatal"
```

```json
{
  "events": [
    {
      "received_at": "2026-11-06T14:06:21.726Z",
      "key_id": "ZEDH3RB37RV1",
      "skew_ms": 726,
      "event": {
        "schema_version": 1,
        "event_id": "01JBQ4Z3H8X9T2K7M5N6P8R9SV",
        "project_id": "prj_isdkxqf9vy94reeg",
        "timestamp": "2026-11-05T09:14:33.412Z",
        "kind": "exception",
        "severity": "error",
        "message": "Database request failed while charging invoice",
        "fingerprint": "DatabaseError:charge-invoice",
        "service": "billing-api",
        "environment": "production",
        "release": "1.4.2",
        "exception": {
          "type": "DatabaseError",
          "value": "connection terminated unexpectedly",
          "stacktrace": "DatabaseError: connection terminated unexpectedly\n    at Client.query (/app/node_modules/pg/lib/client.js:526:17)\n    at chargeInvoice (/app/src/invoices/charge.ts:42:19)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)"
        },
        "sdk": { "name": "@jekimo/sdk-node", "version": "0.1.0" },
        "context": { "host": "billing-api-6c9d7b", "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "request_id": "req_7f3c2a1b" },
        "attributes": { "db_pool": { "idle": 0, "size": 10 }, "password": "[REDACTED]", "invoice_id": "inv_000123", "retry_count": 2 }
      }
    }
  ]
}
```

The server set `project_id` from the key, kept the explicit `fingerprint` from the example (it derives one when the event has none), recorded `skew_ms` (`received_at` minus `sent_at`), and redacted `password` with the default key list. Query parameters, all optional and combined with AND:

| Parameter | Meaning |
| --- | --- |
| `from`, `to` | RFC 3339 bounds on `received_at`; `from` inclusive, `to` exclusive. Default: the last 24 hours. |
| `severity` | Comma-separated severities, for example `error,fatal`. |
| `kind` | Comma-separated kinds: `exception`, `log`, `event`. |
| `environment`, `release`, `fingerprint` | Exact match on that field. |
| `q` | Words that must all appear in `message`, case-insensitive. A word is a run of letters and digits, so `q=internal` matches `db.internal`. No ranking, stemming, or prefix matching. |
| `limit` | 1 to 500, default 100. |
| `cursor` | The `next_cursor` of the previous page. Keep the other parameters the same. |

To read one event by its id:

```bash
curl -s -b cookies.txt "http://127.0.0.1:8080/api/v1/projects/$PROJECT_ID/events/01JBQ4Z3H8X9T2K7M5N6P8R9SV"
```

The response is one element of the `events` list above. An id that does not exist in this project, including one that exists in a project you cannot access, answers `404`.

The event also opened an issue, grouped by its fingerprint:

```bash
curl -s -b cookies.txt "http://127.0.0.1:8080/api/v1/projects/$PROJECT_ID/issues?status=unresolved"
```

The response lists issues with `id`, `title`, `status`, `event_count`, `first_seen`, `last_seen`, and `last_event_id`; filters and paging are in [apps/api/README.md](../apps/api/README.md). Take an issue's `id` to read it with its latest event, or to resolve it (state-changing requests need the CSRF token from sign-in):

```bash
curl -s -b cookies.txt "http://127.0.0.1:8080/api/v1/projects/$PROJECT_ID/issues/$ISSUE_ID"
curl -s -b cookies.txt -X POST -H "x-jekimo-csrf-token: $CSRF" \
  "http://127.0.0.1:8080/api/v1/projects/$PROJECT_ID/issues/$ISSUE_ID/resolve"
```

`/ignore` and `/reopen` work the same way. If a resolved issue receives a new event, the worker reopens it.

## 8. Check the isolation rules

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $JEKIMO_KEY" http://127.0.0.1:8080/api/v1/projects
```

`401`: an ingestion key is never accepted outside ingest.

```bash
curl -s -b cookies.txt -X POST http://127.0.0.1:8080/api/v1/ingest -H 'content-type: application/json' -d @events.json
```

`{"error":{"code":"unauthorized",...}}`: a session cookie cannot reach ingest.

```bash
curl -s -b cookies.txt http://127.0.0.1:8080/api/v1/projects/prj_not_mine/events
```

`{"error":{"code":"not_found","message":"project not found"}}`: projects you cannot access look like projects that do not exist.

## 9. Invite someone and share the project

There is no outgoing email: an instance admin creates an invitation and hands the link over themselves.

```bash
curl -s -b cookies.txt -X POST http://127.0.0.1:8080/api/v1/invitations \
  -H "x-jekimo-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"email":"dev@example.test"}'
```

```json
{"invitation":{"id":"5b0c3f0e-8a77-4c55-9d0e-2f1a6c3d9b10","email":"dev@example.test","instance_role":"member","created_by":"57d867a7-12ad-4cb6-8f17-4ca00904a91a","created_at":"2026-11-06T14:10:02.000Z","expires_at":"2026-11-13T14:10:02.000Z"},"token":"<token, shown once>","link":"/invite#token=<token, shown once>","notice":"This link is shown once and works once. Hand it to the person over a channel you trust."}
```

Set `JEKIMO_PUBLIC_URL` to get full links; with `JEKIMO_PUBLIC_URL=http://localhost:8081` the link opens the dashboard's invitation page. From a shell, the invitee accepts by posting the token with a password of their choice:

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/invitations/accept \
  -H 'content-type: application/json' \
  -d '{"token":"<token>","password":"synthetic-password-456"}'
```

The project admin then adds them to the project with a role, and can rotate the setup key (the old key keeps working for 24 hours by default) or revoke it:

```bash
curl -s -b cookies.txt -X POST "http://127.0.0.1:8080/api/v1/projects/$PROJECT_ID/members" \
  -H "x-jekimo-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"email":"dev@example.test","role":"viewer"}'
```

```bash
curl -s -b cookies.txt -X POST "http://127.0.0.1:8080/api/v1/projects/$PROJECT_ID/keys/<key_id>/rotate" \
  -H "x-jekimo-csrf-token: $CSRF" -H 'content-type: application/json' -d '{"grace_hours":1}'
```

Every one of these actions is in the audit log, without tokens or keys:

```bash
curl -s -b cookies.txt "http://127.0.0.1:8080/api/v1/audit-log?limit=10"
```

If you lose the admin password, print a reset link on the server:

```bash
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml exec api jekimo admin reset-password admin@example.test
```

Every route is listed in [`apps/api/README.md`](../apps/api/README.md#endpoints).

## Running the services outside Docker

With only `postgres` running from the compose file:

```bash
set -a; . ./.env; set +a
```

```bash
npm run migrate -w @jekimo/storage-postgres
```

```bash
npm run dev -w @jekimo/api
```

```bash
npm run dev -w @jekimo/worker
```

```bash
npm run dev -w @jekimo/web
```

The dashboard's dev server runs on <http://localhost:5173> with hot reload and proxies `/api` to the API on `127.0.0.1:8080` (`JEKIMO_DEV_API_URL` to change it).

## Tests

```bash
npm run check
```

Unit tests always run. Integration tests against PostgreSQL run when `JEKIMO_DATABASE_URL` is set (or the deprecated `DATABASE_URL`), each in a throwaway schema, and are skipped otherwise:

```bash
set -a; . ./.env; set +a; npm test
```

## Clean up

```bash
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml down -v
```

`-v` also deletes the database volume, so the next start prints a new setup token.
