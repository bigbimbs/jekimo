# Ingestion protocol

This document is the public contract for sending events to a Jekimo instance, **protocol version 1**. SDKs implement the client side; `apps/api` implements the server side. The reference types, ingestion key parser, and batch validator live in `packages/event-schema/src/ingest.ts`.

The event envelope itself is specified separately in [event-format.md](event-format.md). This document covers transport, authentication, batching, responses, limits, and retry behavior.

Key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as in RFC 2119.

Status: draft. The protocol may change until the first stable release. After that, changes follow the compatibility rules at the end of this document.

## Design goals

- A single, boring HTTP endpoint that any language can call without a client library.
- The server, never the client, decides which project an event belongs to.
- `202 Accepted` means durable: the event is in the queue and will not be lost by a storage hiccup.
- Clear per-event feedback so SDK authors can debug payloads.
- Bounded: every request, event, and project has limits, and the limits are enforced before expensive work.

## Endpoint

```
POST {base_url}/api/v1/ingest
```

`base_url` is the instance address, for example `https://jekimo.example.com`. The path is versioned independently of the envelope's `schema_version`.

The endpoint MUST be served over HTTPS. Plain HTTP is only acceptable on the loopback interface for local development.

## Authentication

Every request carries a project **ingestion key** in the `Authorization` header:

```
Authorization: Bearer jk_01JBQ4Z3H8X9_wq7m2k9f4t8v1x3z6b5n8c2d7g4h1j5r
```

### Key format

```
jk_<key_id>_<secret>
```

| Part | Format | Purpose |
| --- | --- | --- |
| `jk` | literal | Marks the string as a Jekimo ingestion key so leaked keys can be found by secret scanners. |
| `key_id` | 12 characters, Crockford base32 (`0-9`, `A-Z` without `I`, `L`, `O`, `U`) | Public identifier. Safe to log and to show in the dashboard. Used to look up the key record. |
| `secret` | 32 characters from `a-z`, `0-9` | 160 bits of randomness. Never logged, never stored in plain text, never shown again after creation or rotation. |

The server stores `key_id` in plain text and a SHA-256 hash of the whole key string. Because the secret is high-entropy random data, a fast hash is sufficient; a password hash is not required. Comparison MUST be constant-time.

### Rules

- A key belongs to exactly one project. The project is derived from the key on every request. A request MUST NOT be able to target another project by any field in the body or URL.
- Keys are shown once, at creation and at rotation. Rotation creates a new key and keeps the old one valid for a configurable grace period (default 24 hours) so deployments can roll.
- Revocation takes effect immediately. A revoked, unknown, or malformed key yields `401`.
- Keys grant ingestion only. They MUST NOT be accepted by any other endpoint, including the query API and the dashboard.
- Keys MUST NOT be placed in URLs or query strings.
- Server logs MAY include `key_id`. They MUST NOT include the secret or the full key.

## Request

### Headers

| Header | Required | Value |
| --- | --- | --- |
| `Authorization` | Yes | `Bearer <ingestion key>` |
| `Content-Type` | Yes | `application/json` (a `charset=utf-8` parameter is allowed). Anything else yields `415`. |
| `Content-Encoding` | No | `gzip`. Servers MUST support it. SDKs SHOULD compress bodies larger than 8 KiB. |
| `Content-Length` | Yes for uncompressed bodies | Used for early rejection of oversized requests. |
| `User-Agent` | SHOULD | `<sdk name>/<version>`, for example `@jekimo/sdk-node/0.1.0`. |

### Body

```json
{
  "sent_at": "2026-11-05T09:14:35.002Z",
  "events": [
    { "schema_version": 1, "event_id": "01JBQ4Z3H8X9T2K7M5N6P8R9SV", "timestamp": "2026-11-05T09:14:33.412Z", "kind": "log", "severity": "info", "message": "..." }
  ]
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `events` | Yes | Array of 1 to 100 event envelopes in **ingest form** (no `project_id`). See [event-format.md](event-format.md). |
| `sent_at` | No | RFC 3339 time at which the SDK sent the request, by the client's clock. Used for clock skew correction (below). |

Unknown top-level fields in the body are ignored.

### Limits

| Limit | Value | On violation |
| --- | --- | --- |
| Events per request | 100 | `400 too_many_events` |
| Request body after decompression | 1 MiB | `413 payload_too_large` |
| Compressed request body | 1 MiB | `413 payload_too_large` |
| One event, serialized | 128 KiB | Per-event rejection, code `max_size` |

Servers MUST check `Content-Length` before reading the body, and MUST stop decompressing once the decompressed limit is reached. A compressed body that expands past the limit is rejected, not truncated.

## Processing

For each request the server:

1. Validates the key and resolves the project. Failure: `401`.
2. Checks that the project is enabled and not over quota. Failure: `403` or `429`.
3. Checks rate limits. Failure: `429` with `Retry-After`.
4. Parses the body and applies request-level limits. Failure: `400`, `413`, or `415`.
5. Validates each event in ingest mode, drops unknown fields, and records warnings.
6. Deduplicates by `event_id` within the request.
7. Writes accepted events to the durable queue, stamped with `project_id`, `received_at`, and the key's `key_id`. Events already accepted by an earlier request are not filtered out here; they are dropped when the worker appends them to the event store (see Deduplication).
8. Returns `202` with per-event results.

If step 7 fails, nothing from the request is accepted and the server returns `503` with `Retry-After`. Partial writes MUST NOT be acknowledged.

### Clock skew

The future-timestamp rule in the event format (reject events more than 5 minutes in the future) is evaluated against `sent_at` when it is present and parseable, and against the server clock otherwise. The server also records `skew = received_at - sent_at` and attaches it to stored events so the dashboard can show corrected times for clients with wrong clocks. The stored `timestamp` is never modified.

### Deduplication

`event_id` is unique per project: the same `event_id` in two projects is two different events. If an accepted event is sent again, for example because the SDK retried after a lost response, the server acknowledges it as accepted and stores nothing new.

- Duplicates within one request are accepted once and queued once (Processing, step 6).
- Across requests, deduplication happens when the worker appends events to the event store, not when the API writes to the queue. The event store records each `(project_id, event_id)` it stores in a deduplication index, in the same transaction as the event itself, and skips any event whose id is already recorded. A repeat is therefore listed in `accepted`, MAY pass through the queue again, and is dropped at append. Appends MUST stay idempotent, so a redelivered queue job is also harmless.
- The deduplication window is at least 7 days, measured from the `received_at` of the stored copy. The expiry pass removes older index entries ([retention.md](retention.md), "What is retained"). A repeat that arrives after its entry was removed is stored as a new event.

## Responses

### `202 Accepted`

Returned whenever the request was authenticated, parsed, and processed, **even if every event was rejected**. Per-event outcomes are in the body.

```json
{
  "accepted": ["01JBQ4Z3H8X9T2K7M5N6P8R9SV"],
  "rejected": [
    {
      "index": 1,
      "event_id": "01JBQ50A6D2V8W4Y1Z3X5C7B9N",
      "errors": [
        { "path": "/message", "code": "required", "message": "/message is required" }
      ]
    }
  ],
  "warnings": [
    { "index": 0, "path": "/future_field", "code": "unknown_field", "message": "/future_field is not part of schema version 1 and was dropped" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `accepted` | `event_id`s that are now durably queued, including repeats of events accepted earlier, which are dropped when stored (see Deduplication). Each id appears once. |
| `rejected` | One entry per rejected event with its position in the request `events` array, its `event_id` when one could be read, and the validation issues from the event format. |
| `warnings` | Issues that did not cause rejection, such as dropped unknown fields. Omitted when empty. |

### Request-level errors

The body is always:

```json
{ "error": { "code": "rate_limited", "message": "Project exceeded 1000 events per minute", "retry_after": 12 } }
```

| Status | `code` | When | Retry? |
| --- | --- | --- | --- |
| `400` | `invalid_json` | Body is not valid JSON or not UTF-8. | No |
| `400` | `invalid_request` | Body is not an object, `events` is missing, not an array, or empty. | No |
| `400` | `too_many_events` | More than 100 events. | No. Split the batch. |
| `401` | `unauthorized` | Missing, malformed, unknown, or revoked key. | No |
| `403` | `project_disabled` | Project is disabled by the operator. | No |
| `413` | `payload_too_large` | Body exceeds 1 MiB. | No. Split the batch. |
| `415` | `unsupported_media_type` | `Content-Type` is not JSON or `Content-Encoding` is not supported. | No |
| `429` | `rate_limited` | Per-project rate limit exceeded. | Yes, after `Retry-After`. |
| `429` | `quota_exceeded` | Per-project event quota for the period exhausted. | Yes, after `Retry-After`. |
| `503` | `unavailable` | Queue or storage unavailable. | Yes, after `Retry-After`. |

`Retry-After` is sent as a header (seconds) and mirrored in `error.retry_after` for `429` and `503`.

### Headers on every response

| Header | Meaning |
| --- | --- |
| `X-Jekimo-Request-Id` | Server-generated id for support and log correlation. |
| `X-RateLimit-Limit` | Events allowed per minute for the project. |
| `X-RateLimit-Remaining` | Events remaining in the current window. |
| `X-RateLimit-Reset` | Seconds until the window resets. |

## Rate limits and quotas

Every project has a rate limit, in events per minute, and MAY have a quota, in events per day or month. Both are configured by the instance operator with instance-wide defaults. Rate limits protect the VPS from bursts; quotas keep one project from consuming the whole retention budget.

Defaults to ship with: 1,000 events per minute, no quota. The install guide must explain how to size these for the VPS.

When a quota is exhausted the server returns `429 quota_exceeded` until the period rolls over, and the dashboard shows a notice on the project. Events over quota are dropped, not queued.

## SDK requirements

An SDK implementing this protocol MUST:

- Buffer events in memory with a bounded queue (default 1,000 events) and drop the oldest when full. Dropped counts SHOULD be reported in the next request as a `log` event or in an SDK-internal counter.
- Send in the background, never on the application's request path, and never block process exit for longer than a short, configurable flush timeout (default 2 seconds).
- Flush when any of these is reached: 100 events, 512 KiB of serialized events, or a flush interval (default 2 seconds).
- Retry on network errors, `429`, `503`, and any other `5xx` with exponential backoff starting at 1 second, doubling to a cap of 60 seconds, with full jitter, honoring `Retry-After` when present. Give up on a batch after 5 attempts and drop it.
- Not retry any other `4xx`. Those are bugs in the SDK or configuration and retrying cannot help. Log them locally once.
- Treat `202` with rejections as success for the accepted events and log the rejections locally. Do not resend rejected events.
- Send the `User-Agent` header and the `sdk` field in each event.
- Never log the ingestion key.

## Security notes

- The ingestion endpoint is not browser-facing in protocol version 1 and MUST NOT send CORS headers. Browser SDKs will get a separate, origin-restricted endpoint.
- Servers MUST NOT echo request bodies in error responses or logs.
- Servers SHOULD apply a per-IP connection limit in front of the endpoint in addition to per-project limits.
- Malformed keys are rejected with the same `401` as unknown keys, with the same timing characteristics, so the response does not reveal whether a `key_id` exists.

## Compatibility rules

- Additive changes (new optional request fields, new response fields, new warning codes, new headers) do not change the path. Clients MUST ignore response fields they do not know.
- New request-level error codes MAY be added. Clients MUST treat an unknown code under `4xx` as non-retryable and under `5xx` as retryable.
- Breaking changes move to `/api/v2/ingest`. The previous version is served for at least one minor release cycle after the new one ships, announced in `CHANGELOG.md`.
- Limits may be raised without a version change. They are only lowered with a version change.

## Open questions

- Whether to accept newline-delimited JSON as an alternative body format for streaming clients.
- Per-environment keys versus per-project keys.
- A signed request mode for environments where a bearer token in a header is not acceptable.
