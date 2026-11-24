# Cron and scheduled-job monitoring

Jekimo monitors jobs where they already run. It does not schedule or execute shell commands. The first version provides five-field cron schedules, IANA timezones, start/completion/error check-ins, missed-start and timeout detection, run history, pause/resume, and failure/recovery notifications through existing project connections.

Apply migration `0012_cron.sql` and run the updated API and worker. The cron scanner runs independently of notification delivery, checking due monitors every five seconds in batches of 100. History and health work without email or Slack configured. Notifications require the shared encryption key and delivery configuration described in [notifications.md](notifications.md).

## Create a monitor

Open **Cron jobs** at `/projects/:projectId/cron`. Project readers can view health and run history; `settings.manage` is required to create, pause, or resume a monitor. Configure:

- Job name.
- Five-field cron expression: minute, hour, day of month, month, day of week. For example `0 2 * * *` means daily at 02:00 in the selected timezone.
- An IANA timezone, such as `UTC` or `Africa/Lagos`. The parser handles timezone and daylight-saving transitions. Six-field/second schedules, `@` aliases, and randomized `H` fields are not supported.
- Grace period for a late start, from 0 to 86,400 seconds.
- Maximum runtime, from 1 to 604,800 seconds.
- Consecutive failure and recovery thresholds, each from 1 to 100.
- An optional existing project notification connection. With no connection, health/history still work.

Each project supports at most 100 monitors. Settings are selected at creation; editing schedules and deleting monitors are not in this first version. Pause the old monitor and create a replacement when changing a schedule. Resume starts a fresh schedule from the current time and resets the incident/threshold state, without backfilling the paused period. Pausing preserves completed history and marks currently running jobs as cancelled; a late completion for those run IDs cannot reopen or recover an incident.

## Send check-ins

Use a project ingestion key in `Authorization: Bearer …`. Dashboard session cookies cannot authenticate check-ins. Keys are subject to revocation, expiry, project-disabled checks, and disk-full refusal. The server derives the project from the credential and rejects project IDs supplied in a request body.

`POST /api/v1/cron/:monitorId/check-ins`, with JSON:

```json
{"run_id":"00000000-0000-4000-8000-000000000001","status":"started"}
```

Generate a new UUID for every actual execution. Send `started` when work begins, then `ok` or `error` with **the same UUID**. The example UUID is synthetic: do not reuse it for successive jobs. Do not send exception messages, SQL, credentials, or job output in this endpoint. Use the normal exception/log pipeline for those, subject to its redaction rules.

A completion-only `ok`/`error` check-in is supported for heartbeats; without a start it has no measured duration. A start replay arriving after completion does not overwrite that result. Repeating the same status is idempotent within retained history; conflicting final results return 409. Overlapping executions are tracked independently by run ID. Each monitor accepts up to 120 requests per minute and 100 concurrent running jobs. Payloads are limited to 4 KiB. Rate limits return 429; paused monitors return 409; unknown or other-project monitor IDs return 404.

Check-ins are committed to PostgreSQL before the API answers. Receipts use server time. A run received at or after the next expected time satisfies that scheduled start; an earlier run is recorded as an ad hoc execution and does not satisfy a future scheduled start. Keep job hosts and Jekimo clocks synchronized. Starts within the grace period are accepted; after it, the missing slot is recorded before the new run is processed. When a late start covers several overlapping grace windows, the next expected time advances to the next schedule after its receipt.

A started run that passes its maximum runtime is marked timed out even if a late success arrives before the scanner. A late completion does not rewrite a timeout. Use a new run ID for an actual retry execution. Missing windows discovered after a Jekimo outage collapse into one missed record for the first missing slot per scan, rather than reconstructing every historical run. This counts as one failure toward the threshold and avoids an alert flood. Jekimo cannot distinguish a failed job from lost check-in traffic.

## Node.js SDK

The alpha SDK includes `createCronMonitor`, independent of the normal error/log client:

```ts
import { createCronMonitor } from "@jekimo/sdk-node";

const monitor = createCronMonitor({
  baseUrl: process.env.JEKIMO_URL!,
  ingestionKey: process.env.JEKIMO_INGESTION_KEY!,
  monitorId: process.env.JEKIMO_CRON_MONITOR_ID!,
});

try {
  await monitor.withMonitor(async () => {
    await runBackup();
  });
} finally {
  await monitor.close(2000);
}
```

`withMonitor` queues start/end check-ins without awaiting the network on the job path. It preserves the job's return value and thrown error. The sender processes check-ins in order with up to three attempts for transient errors. `checkIn(status, runId?)` provides manual reporting; it returns the run ID or `undefined` when disabled or dropped. `flush(timeoutMs)` waits for pending delivery, and `close(timeoutMs)` then stops the client. They return false when the wait expires or a delivery/drop has failed. Call close explicitly for short-lived processes: the helper does not install process handlers or keep an otherwise idle process alive.

The helper's default in-memory queue limit is 100, configurable from 2 to 1,000. Each network attempt has a five-second timeout; redirects are refused, credentials stay in headers, and only HTTPS or HTTP loopback destinations are accepted. `onError` receives safe diagnostic messages, never the key or response body. The queue is not durable across application crashes; missing completion signals are precisely what timeout monitoring detects. SDK publication to npm remains a maintainer release action; this change does not publish it.

## Health, notifications, and retention

The monitor opens an incident when consecutive failures reach the configured threshold. Missed starts, explicit errors, and timeouts count as failures. Consecutive successes reaching the recovery threshold close it. Outcomes are processed in receipt/detection order, including overlapping runs. Failures reset the success streak and successes reset the failure streak. Duplicate requests do not change either streak.

Health changes and notification enqueueing share a metadata transaction. Only an incident's opening and recovery enqueue messages; repeated failures within the same incident do not page repeatedly. Notifications use the existing durable delivery queue and its retry, destination-security, and at-least-once semantics. If the selected connection is disabled, no notification is enqueued for that transition and it is not replayed on re-enable.

Run history is retained for 30 days and each history response displays the latest 100 runs. Monitor health and the last successful time persist beyond history expiry. Check-in retries older than retention are no longer deduplicated; never reuse execution IDs. Create/pause/resume actions appear as project-settings changes in the audit log. Keep an external heartbeat on the Jekimo instance itself, because a stopped worker cannot detect or notify on new failures until it returns.

## API routes

| Route | Authentication |
| --- | --- |
| `GET /api/v1/projects/:id/cron-monitors` | Session, `project.read` |
| `POST /api/v1/projects/:id/cron-monitors` | Session + CSRF, `settings.manage` |
| `PATCH /api/v1/projects/:id/cron-monitors/:monitor` | Session + CSRF, `settings.manage`; body `enabled` |
| `GET /api/v1/projects/:id/cron-monitors/:monitor/runs` | Session, `project.read` |
| `POST /api/v1/cron/:monitor/check-ins` | Project ingestion key |

Creation accepts `name`, `expression`, `timezone`, `graceSeconds`, `maxRuntimeSeconds`, `failureThreshold`, `recoveryThreshold`, and `channelId` (UUID or null). Creation returns a `monitor`, listing returns `monitors`, history returns `runs`, and a check-in returns its `run` with server timestamps.
