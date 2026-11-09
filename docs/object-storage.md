# Object storage: cold tier, backups, and exports

This document specifies how a Jekimo instance uses S3-compatible object storage. Object storage is **optional**. An instance without it keeps everything in PostgreSQL and on local disk, exactly as described in [retention.md](retention.md). When a bucket is configured, the instance gains a cold tier for old events, a destination for backups and exports, and later a home for large payloads.

It is normative for the worker, the storage layer, the API, and the install guide. The archive key layout and the hot/cold retention split are encoded in `packages/event-schema/src/archive.ts`.

Key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as in RFC 2119.

Status: draft. Target: Phase 2 (production readiness). Not part of the Phase 1 MVP.

## Why

- Long retention becomes cheap. Object storage costs roughly $0.015 per GB-month; 100 GB of archived events is about $1.50 a month, and providers with no egress fees make occasional restores free.
- The VPS disk stops being the limit on retention, which also softens the disk-safety story: at the critical level the instance can archive instead of delete.
- Backups land off the box, where a dead VPS cannot take them along.

## What object storage is not used for

The hot path stays in PostgreSQL: issue grouping, filters, search, and the dashboard. Object storage has no indexes and no fast point queries. Archived events are not searchable until restored, with direct querying of archived files listed as a later milestone.

## Providers

The boundary is the S3 API, so the instance is not tied to one vendor.

| Provider | Endpoint style | Notes |
| --- | --- | --- |
| Cloudflare R2 | `https://<account_id>.r2.cloudflarestorage.com`, region `auto`, path-style | No egress fees. Recommended default for VPS operators. |
| AWS S3 | Regional endpoint, virtual-hosted style | Egress is billed; restores cost money. |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com`, path-style | Cheap storage, free egress up to a multiple of stored data. |
| MinIO or other self-hosted S3 | Operator's endpoint, path-style | For fully on-premises installs. |
| Local filesystem | `file:///var/lib/jekimo/objects` | Development, tests, and single-box installs with a second disk. Same layout, no network. |

Operators configure one object store per instance in version 1.

## The object store boundary

`packages/storage-postgres` owns PostgreSQL; the object store is a separate boundary so neither depends on the other. The interface the rest of the system sees:

| Operation | Purpose |
| --- | --- |
| `put(key, body, { contentType, sha256, ifNoneMatch })` | Upload one object, streaming, with multipart for bodies over 64 MiB. `ifNoneMatch: "*"` makes creation idempotent. |
| `get(key, { range })` | Stream an object or a byte range. |
| `head(key)` | Size, ETag, and checksum metadata without the body. |
| `list(prefix, { after, limit })` | Paginated listing under a prefix. |
| `delete(keys)` | Delete up to 1,000 keys per call. |
| `presignGet(key, ttlSeconds)` | Short-lived download URL. Used only for exports. |
| `capabilities()` | Whether conditional puts, checksums, and presigning are supported, so the filesystem adapter can say no. |

Implementations MUST use a small SigV4 client, not the full AWS SDK, to keep the worker image light. All uploads carry a SHA-256 checksum that is verified against the stored object's metadata after upload.

## Key layout

All keys live under the operator's configured root prefix. Within it:

```
v1/projects/<project_id>/events/<YYYY>/<MM>/<DD>/part-<NNNNN>.ndjson.zst
v1/projects/<project_id>/events/<YYYY>/<MM>/<DD>/manifest.json
v1/projects/<project_id>/exports/<export_id>/<file>
v1/projects/<project_id>/blobs/<sha256>            (planned)
v1/backups/<YYYY-MM-DD>/<HHMMSS>/db.dump.zst
v1/backups/<YYYY-MM-DD>/<HHMMSS>/manifest.json
```

- `project_id` is the project's internal identifier and MUST match `^[a-z0-9][a-z0-9_-]{0,63}$`, so keys are safe and never contain path separators.
- `YYYY/MM/DD` is the **received day in UTC**, matching the PostgreSQL partition key.
- Everything about one project sits under one prefix. Deleting a project deletes its prefix. Listing a project's archive never touches another project's keys. This is how project isolation extends to the bucket.
- Each day has one or more parts, each at most 256 MiB uncompressed, and one manifest written **last**.

### Archive format

Version 1 archives are newline-delimited JSON compressed with zstd. Each line is one stored event: the envelope in stored form plus the server metadata (`received_at`, `key_id`, `skew_ms`). The format is streamable, readable from any language, and needs no schema registry. Parquet is a planned alternative to enable direct querying; the manifest records the format of each part so both can coexist.

### Manifest

```json
{
  "layout_version": 1,
  "project_id": "prj_billing",
  "day": "2026-11-05",
  "format": "ndjson.zst",
  "schema_version": 1,
  "parts": [
    { "key": "part-00000.ndjson.zst", "events": 48213, "bytes": 9123456, "sha256": "..." }
  ],
  "events": 48213,
  "first_received_at": "2026-11-05T00:00:00.112Z",
  "last_received_at": "2026-11-05T23:59:58.901Z",
  "issues": 312,
  "archived_at": "2026-11-20T02:10:41Z",
  "jekimo_version": "0.4.0"
}
```

A day is archived when its manifest exists and every part listed in it exists with a matching size and checksum. A day without a manifest is incomplete and is retried.

## Hot and cold retention

With an object store configured, a project's retention has two parts:

| Setting | Meaning | Default |
| --- | --- | --- |
| `retention_days` | Total time an event is kept, hot plus cold, from `received_at`. | 90 when a bucket is configured, otherwise 30 as in [retention.md](retention.md) |
| `hot_days` | Time an event stays in PostgreSQL and is searchable. Must be between 1 and `retention_days`. | 14 when a bucket is configured, otherwise equal to `retention_days` |

- Without a bucket, `hot_days` equals `retention_days` and the cold tier does not exist. Setting `hot_days` lower than `retention_days` MUST be rejected unless a bucket is configured and healthy.
- Events older than `hot_days` are archived and dropped from PostgreSQL. Events older than `retention_days` are deleted from the bucket.
- Operators bound both with `JEKIMO_RETENTION_MAX_DAYS` and `JEKIMO_HOT_DAYS_MAX`.

### Archiving a day

The worker runs the archive pass after the expiry pass, at least every 15 minutes:

1. Select day partitions older than `hot_days` whose manifest is absent.
2. Stream the partition into parts, compress, upload each with its checksum, and `head` each to verify.
3. Write the manifest.
4. Detach and drop the PostgreSQL partition.
5. Record counts in the project's daily counters and an audit entry.

Steps 2 and 3 are idempotent, so a crash mid-way leaves a day that is simply retried. Step 4 runs only after step 3 succeeds. If the bucket is unreachable, hot data stays in PostgreSQL, admins are notified, and the normal disk-safety rules apply.

### Issues and archived events

An issue stays in PostgreSQL while any of its events exist in either tier. Its counts and first and last seen times keep covering the whole retention period. Opening an issue whose events are all archived shows the summary and offers a restore. An issue is deleted when its last event leaves the cold tier.

### Restoring

- A user with `data.export` on the project can restore a range of archived days back into PostgreSQL, up to `JEKIMO_RESTORE_MAX_DAYS` at once.
- Restored partitions are read-only, marked as restored in the dashboard, counted against disk safety, and dropped again after `JEKIMO_RESTORE_TTL_DAYS`. The archive copy is never deleted by a restore.
- Restores are audit-logged.

### Disk safety with a bucket

Where [retention.md](retention.md) says the critical level caps retention at 7 days, an instance with a healthy bucket **archives** hot days older than 7 days instead of deleting them. Deletion before the configured retention happens only if archiving fails. The full level still refuses ingestion.

## Backups

- When a bucket is configured, the nightly backup job writes a compressed logical dump of PostgreSQL and a manifest with its checksum under `v1/backups/`. Without a bucket, backups go to the local backup directory as described in [backups-and-restore.md](backups-and-restore.md).
- Backups keep the last `JEKIMO_BACKUP_KEEP_DAILY` daily dumps (default 14) and the first dump of each month for `JEKIMO_BACKUP_KEEP_MONTHLY` months (default 6).
- Backups contain ingestion key hashes and user password hashes, never plaintext secrets. They do contain event data, so the bucket MUST be private and SHOULD be encrypted at rest.
- The install guide MUST include a restore drill: restore the latest dump into a scratch database and run the integrity check. Operators SHOULD do this monthly.

## Exports

When a bucket is configured, per-project exports are written under the project's `exports/` prefix and served through presigned URLs with a 15-minute lifetime. Export objects expire after 7 days. Without a bucket, exports are streamed directly from the API.

### Without a bucket

`GET /api/v1/projects/:id/export` streams one project's events. It requires `data.export` on the project; users outside the project get `404` ([access-model.md](access-model.md)).

- The body is newline-delimited JSON (`application/x-ndjson`), one event envelope per line in stored form ([event-format.md](event-format.md)), so every line validates with `validateEvent(line, { mode: "stored" })`. Lines carry no ingestion key id, receive metadata, or any other storage field.
- `from` (inclusive) and `to` (exclusive) are optional RFC 3339 times on when the event was received. Without `from` the export starts at the project's first event; without `to` it ends at the time of the request, so events arriving during a long download are not included. Events are ordered oldest first.
- `compression=gzip` returns the same lines gzip-compressed as `application/gzip`, named `jekimo-<project>.ndjson.gz`.
- Rows are read from the event store in pages of 500 and written as the client reads, so memory use does not depend on project size. The project id comes from the access check and is a parameter of every page query; nothing is filtered afterwards.
- Every export is audit-logged as `data.exported` with the actor, the project, the requested range, and the compression, never the content. The entry is written before the first row is sent, so an abandoned download is still recorded.
- A failure after the first byte ends the response without the final chunk, so clients see a truncated transfer rather than a complete-looking file. Retry the export; it is read-only and can be repeated.
- Exports keep working when the disk is full ([retention.md](retention.md), "Disk safety"), so data can be moved out.

## Large payloads (planned)

Stack traces and attachments above a threshold will be stored as content-addressed blobs under the project prefix, with PostgreSQL holding the reference. This is additive and not part of the first object storage release.

## Security

- Bucket credentials are instance secrets: provided through environment or a secrets file, never shown back in the dashboard, never logged. Rotation is a configuration change plus restart; the old credential MUST remain valid until the new one is live.
- The instance is the only principal that touches the bucket. SDKs and browsers never receive bucket credentials or write URLs. The only URLs handed out are presigned GETs for exports.
- TLS is required for every provider except the filesystem adapter.
- Rely on provider-side encryption at rest (R2 and S3 encrypt by default). Client-side encryption with an instance key is a planned option for operators who do not trust the provider with plaintext.
- Buckets MUST NOT be public. The setup check writes and reads a probe object, verifies the bucket rejects anonymous access when the provider exposes that, and refuses to enable the cold tier otherwise.
- Keys never contain user-supplied strings other than the validated `project_id`.

## Cost example

A project receiving 1,000,000 events a month at about 1 KiB per event compressed produces roughly 1 GB a month of archive. At 365 days of retention that is 12 GB, about $0.18 a month on R2. The hot 14 days stay in PostgreSQL at about 4 KiB per event including indexes, roughly 2 GB.

## Planned configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEKIMO_OBJECT_STORE_URL` | unset | `s3://bucket/prefix` or `file:///path`. Unset disables the cold tier, bucket backups, and bucket exports. |
| `JEKIMO_OBJECT_STORE_ENDPOINT` | provider default | S3 endpoint, for example the R2 account endpoint |
| `JEKIMO_OBJECT_STORE_REGION` | `auto` | S3 region |
| `JEKIMO_OBJECT_STORE_ACCESS_KEY_ID` | unset | Credential |
| `JEKIMO_OBJECT_STORE_SECRET_ACCESS_KEY` | unset | Credential, secret |
| `JEKIMO_OBJECT_STORE_PATH_STYLE` | `true` | Path-style addressing |
| `JEKIMO_HOT_DAYS_DEFAULT` | `14` | Hot period for new projects when a bucket is configured |
| `JEKIMO_HOT_DAYS_MAX` | `365` | Upper bound on `hot_days` |
| `JEKIMO_RESTORE_MAX_DAYS` | `31` | Days restorable in one request |
| `JEKIMO_RESTORE_TTL_DAYS` | `7` | How long restored partitions stay hot |
| `JEKIMO_BACKUP_KEEP_DAILY` | `14` | Daily backups kept |
| `JEKIMO_BACKUP_KEEP_MONTHLY` | `6` | Monthly backups kept |

## Open questions

- Parquet as the archive format, and querying archives in place with an engine such as DuckDB.
- Per-project buckets or credentials for operators who need tenant-level separation at the provider.
- Client-side encryption key management.
- Whether the filesystem adapter should support a second local disk as a "warm" tier without any S3 provider.
