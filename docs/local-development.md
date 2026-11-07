# Local development

This walkthrough runs the whole vertical slice on one machine: PostgreSQL, the API, and the worker in Docker Compose, then setup, a project, an ingestion key, one event sent with curl, and the same event read back. Everything here uses synthetic data.

You need Docker with Compose v2, curl, and Node.js 22 (only for running tests and the services outside Docker). Run every command from the repository root.

## 1. Start the stack

```bash
cp .env.example .env
```

```bash
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml up -d --build
```

This starts four services:

| Service | What it does |
| --- | --- |
| `postgres` | PostgreSQL 16 on `127.0.0.1:5432` (`JEKIMO_DEV_POSTGRES_PORT` to change it). |
| `migrate` | Applies `packages/storage-postgres/migrations/*.sql` and creates event partitions for the coming week, then exits. |
| `api` | The API on `127.0.0.1:8080` (`JEKIMO_DEV_API_PORT` to change it). Starts after `migrate` succeeds. |
| `worker` | Drains the ingest queue and runs the expiry pass. Starts after `migrate` succeeds. |

If port 5432 is already taken by a local PostgreSQL, set `JEKIMO_DEV_POSTGRES_PORT=55432` in `.env` and use the same port in `DATABASE_URL`.

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

## 2. Migrate

Migrations already ran as the `migrate` service. To run them again after adding a migration:

```bash
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml run --rm migrate
```

Or from your machine, against the published port:

```bash
set -a; . ./.env; set +a; npm run migrate -w @jekimo/storage-postgres
```

Each migration is applied once and recorded in `schema_migrations`.

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

Save a batch with one valid exception and one log event that is missing its required `message`:

```bash
cat > events.json <<EOF
{
  "sent_at": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "events": [
    {
      "schema_version": 1,
      "event_id": "01JBQ4Z3H8X9T2K7M5N6P8R9SV",
      "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
      "kind": "exception",
      "severity": "error",
      "message": "Database request failed while charging invoice",
      "service": "billing-api",
      "environment": "development",
      "exception": {
        "type": "DatabaseError",
        "value": "connection terminated unexpectedly",
        "stacktrace": "DatabaseError: connection terminated unexpectedly\n    at chargeInvoice (/app/src/invoices/charge.ts:42:19)"
      },
      "attributes": { "invoice_id": "inv_000123", "password": "synthetic" }
    },
    {
      "schema_version": 1,
      "event_id": "01JBQ50A6D2V8W4Y1Z3X5C7B9N",
      "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
      "kind": "log",
      "severity": "info"
    }
  ]
}
EOF
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

`202` means the accepted event is in the durable queue. Sending the same file again returns the same `accepted` list and stores nothing new, because events are deduplicated on `(project_id, event_id)`.

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
        "timestamp": "2026-11-06T14:06:21.000Z",
        "kind": "exception",
        "severity": "error",
        "message": "Database request failed while charging invoice",
        "fingerprint": "82e87af9d7d305e6753309d14e6ca653425a0b624b8f1b6609d3fb6d92c153ac",
        "service": "billing-api",
        "environment": "development",
        "exception": {
          "type": "DatabaseError",
          "value": "connection terminated unexpectedly",
          "stacktrace": "DatabaseError: connection terminated unexpectedly\n    at chargeInvoice (/app/src/invoices/charge.ts:42:19)"
        },
        "attributes": { "password": "[REDACTED]", "invoice_id": "inv_000123" }
      }
    }
  ]
}
```

The server set `project_id` from the key, derived a `fingerprint`, recorded `skew_ms` (`received_at` minus `sent_at`), and redacted `password` with the default key list. Query parameters: `from` and `to` (RFC 3339, on `received_at`, default the last 24 hours), `severity` (comma-separated), `limit` (1 to 500, default 100), and `cursor` (the `next_cursor` of the previous page).

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

## Tests

```bash
npm run check
```

Unit tests always run. Integration tests against PostgreSQL run when `DATABASE_URL` is set, each in a throwaway schema, and are skipped otherwise:

```bash
set -a; . ./.env; set +a; npm test
```

## Clean up

```bash
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml down -v
```

`-v` also deletes the database volume, so the next start prints a new setup token.
