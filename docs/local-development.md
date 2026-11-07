# Local development

This walkthrough runs the whole vertical slice on one machine: PostgreSQL, the API, and the worker in Docker Compose, then setup, a project, an ingestion key, one event sent with curl, and the same event read back. Everything here uses synthetic data.

You need Docker with Compose v2, curl, [jq](https://jqlang.org/), and Node.js 22 (only for running tests and the services outside Docker). Run every command from the repository root.

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

`migrate` shows `Exited (0)`, `api` shows `healthy`, and:

```bash
curl -s http://127.0.0.1:8080/healthz
```

```json
{"status":"ok"}
```

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

## 3. Create the first instance admin

On first start, with no users in the database, the API prints a one-time setup token to its console:

```bash
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml logs api | grep -A2 "setup token"
```

The token is valid until setup completes or the API restarts. Use it to create the first admin (the password needs 12 to 128 characters):

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/setup \
  -H 'content-type: application/json' \
  -d '{"setup_token":"<token from the api logs>","email":"admin@example.test","password":"synthetic-password-123"}'
```

```json
{"user":{"id":"57d867a7-12ad-4cb6-8f17-4ca00904a91a","email":"admin@example.test","instance_role":"admin","created_at":"2026-11-06T14:06:21.528Z"}}
```

A second attempt returns `410 setup_complete`.

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

## 5. Create a project

```bash
curl -s -b cookies.txt -X POST http://127.0.0.1:8080/api/v1/projects \
  -H "x-jekimo-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"Billing API"}'
```

```json
{"project":{"id":"prj_isdkxqf9vy94reeg","name":"Billing API","retention_days":30,"sample_rate":1,"disabled":false,"created_at":"2026-11-06T14:06:21.656Z"}}
```

```bash
PROJECT_ID='<project id from the response>'
```

## 6. Create an ingestion key

```bash
curl -s -b cookies.txt -X POST "http://127.0.0.1:8080/api/v1/projects/$PROJECT_ID/keys" \
  -H "x-jekimo-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"local"}'
```

```json
{"key_id":"ZEDH3RB37RV1","key":"jk_ZEDH3RB37RV1_<secret, shown once>","name":"local","created_at":"2026-11-06T14:06:21.694Z","notice":"This key is shown once. Store it in your secret manager now."}
```

The full key is returned only here. The database keeps `key_id` and a SHA-256 hash of the key; the audit log records `ingestion_key.created` with the `key_id` only.

```bash
JEKIMO_KEY='<key from the response>'
```

## 7. Send events

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

## 8. Read it back

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

The server set `project_id` from the key, kept the explicit `fingerprint` from the example (it derives one when the event has none), recorded `skew_ms` (`received_at` minus `sent_at`), and redacted `password` with the default key list. Query parameters: `from` and `to` (RFC 3339, on `received_at`, default the last 24 hours), `severity` (comma-separated), `limit` (1 to 500, default 100), and `cursor` (the `next_cursor` of the previous page).

## 9. Check the isolation rules

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
