# Notifications and basic issue alerts

Implemented: cron monitor failure/recovery notifications (see [cron monitoring](cron-monitoring.md)), SMTP settings, project email/Slack/webhook connections, new-error, regression, and slow-query rules, queued tests, and delivery history. This is the first notification milestone. Error-count thresholds, environment/service filters, maintenance windows, issue recovery notifications, on-call escalation, and automatic invitation/reset email delivery remain planned. Existing invitation and password-reset links are still shared manually.

## Configure the instance

Apply migration `0011_notifications.sql` before running the updated API and worker. Set `JEKIMO_NOTIFICATIONS_ENCRYPTION_KEY` to the same randomly generated 32-byte hexadecimal key on both services (`openssl rand -hex 32`). Store it securely outside the database and back it up separately. Losing or replacing it makes saved SMTP and connection settings unreadable; this release has no automatic key-rotation tool. Configure `JEKIMO_PUBLIC_URL` on the worker to include links to issues in alerts.

Instance administrators open **Administration → Email** (`/admin/email`) to set the SMTP host, port, TLS/STARTTLS mode, username, password, sender address/name, and enabled state. TLS certificate verification and encryption are required. Private SMTP relays are supported because the instance administrator explicitly selects the server. Anonymous SMTP authentication is supported by leaving the username blank. Leaving the password blank on an update retains the existing password; it is never returned by the API. Save first, then queue a test email and inspect delivery history. Without the encryption key, configuration writes are unavailable and the notification worker does not start.

No email service is bundled. Configure credentials for an SMTP provider or relay you control. Verify its sender/domain requirements with that provider. A successful queue response is not confirmation of delivery.

## Project connections and rules

Users with the existing `settings.manage` permission can use **Integrations** (`/projects/:projectId/integrations`) and **Alerts** (`/projects/:projectId/alerts`). The server resolves project membership before accessing configuration or delivery history. Other project roles cannot read or change notification destinations.

Connections support:

- **Email:** one recipient address per connection, using the instance SMTP configuration.
- **Slack:** an incoming webhook from `hooks.slack.com` or `hooks.slack-gov.com`. The full URL is a credential and is encrypted, never returned after creation.
- **Webhook:** a public HTTPS URL on port 443 and a signing secret of at least 32 characters, supplied by the operator. Keep the secret in the receiving service too; Jekimo never displays it again.

Add a replacement connection and move rules through the API (or create replacement rules in the dashboard) when rotating destinations or credentials; disable the old connection. Disabled connections cancel pending sends when claimed. Disabling a rule stops future scheduling, while already queued deliveries remain eligible unless their connection is disabled. A delivery already in flight may finish.

Each rule selects one connection and **A new error issue appears**, **A resolved issue occurs again**, or **A database call is slow**, with a 1–1440 minute cooldown per rule and issue. Only exception issues or issues whose latest severity is error/fatal generate signals. Ordinary info logs do not trigger these rules. Manual reopening is not a regression. Rules apply prospectively and do not backfill existing issues. Each project supports up to 50 connections and 50 rules.

### Slow-query rules

Apply migration `0014_slow_query_alerts.sql` and update the API and worker. In **Alerts**, choose **A database call is slow**, set a duration threshold (whole milliseconds, 1–604800000), and optionally enter an exact environment and static operation name. Empty filters match all values. The threshold is inclusive and applies to individual recorded calls, both completed and failed; it is not a percentile or an aggregate over a time window. These saved thresholds are independent of the temporary threshold used to explore the Database page.

The cooldown applies to the entire rule, across all matching operation names (1–1440 minutes). **Edit rule** updates its connection, trigger, threshold, filters, and cooldown; it preserves whether the rule is enabled. **Disable** stops future evaluation, while already queued messages remain eligible. Disable the connection to cancel pending deliveries when claimed. An in-flight send may still finish.

Rules apply only to calls received after their most recent save, including re-enabling, and to calls received within the last 24 hours. Existing records are not scanned or backfilled. Calls processed while a rule or connection is disabled are not replayed on re-enable. Sampling, ingestion rejection, and local queue drops can omit calls; alerts cover stored telemetry, not every database call. Query alerts require the explicit SDK instrumentation described in [database-monitoring.md](database-monitoring.md).

After the event store append, the worker evaluates canonical stored measurements in a separate metadata transaction. This writes a processing receipt, applies cooldowns, and enqueues delivery atomically. A retry after a metadata failure can resume without appending the event twice. Processing receipts deduplicate by project/event ID and are retained for eight days; receipt-age checks prevent old retries from becoming fresh alerts. Concurrent evaluations are serialized per project. A full delivery queue records a failed delivery with `queue_full` and consumes that cooldown; it does not repeatedly retry scheduling the same event. Query receipts are pruned by the ingestion worker's expiry pass even when delivery is not configured.

Messages contain the operation name, measured duration, threshold, and a Database-page link when the worker has a public URL. They exclude SQL, parameters, result rows, and exception messages. Query alerts do not create error issues or automatic recovery notifications.

Messages include a short issue title and, when the worker has a public URL, an issue link. They do not include full event payloads, stack traces, or user attributes. Treat issue titles as project data and connect only destinations authorized to receive it. Connection and rule changes use the existing project-settings audit action; SMTP changes use the instance-settings action. Audit details exclude credentials and recipient addresses.

## Delivery and failure behavior

Issue creation/regression writes a notification signal in the same metadata transaction. A separate worker schedules deliveries from those signals. Event storage remains a separate boundary, and network delivery never runs on ingestion's request path. Replaying an ingestion job does not create duplicate signals for the same issue transition. Concurrent schedulers serialize cooldown decisions; workers claim deliveries with a two-minute lease and fenced acknowledgements.

Transient delivery errors retry up to five attempts, with exponential delays beginning at 30 seconds. Permanent HTTP errors (including redirects, excluding 408/429) and SMTP 5xx errors stop immediately. HTTP requests time out, redirects are not followed, DNS results must all be public addresses, and the connection is pinned to a validated address to prevent DNS rebinding. SMTP has connection, socket, and overall time limits. Error records contain safe failure codes, never provider response bodies or secret URLs.

Delivery is at least once across the external provider boundary: if a provider accepts a message and the worker crashes before recording success, retry can send it again. Webhook receivers should deduplicate by delivery ID. Email retries use a stable Message-ID, but SMTP cannot guarantee deduplication. **Sent** means the service accepted the message, not that a person read it or that an email reached the inbox.

Up to 1,000 alert deliveries per project can be pending; overflow is recorded as failed with `queue_full`. Pending deliveries expire after one day. History is retained for 30 days, and the UI/API show the latest 100 rows. Test requests are limited to one per connection per minute; instance email tests share a one-per-minute limit. Delivery status refreshes every ten seconds in the dashboard.

## Webhook verification

The request body is JSON containing `id`, `subject`, `text`, and, for issue alerts, `projectId`, `issueId`, and `trigger`. Slow-query alerts include `projectId`, `eventId`, and `trigger: slow_query`. Requests include:

- `X-Jekimo-Delivery-Id`: stable across retries.
- `X-Jekimo-Timestamp`: Unix seconds for this attempt.
- `X-Jekimo-Signature`: `sha256=` followed by the hexadecimal HMAC-SHA256 of `<timestamp>.<raw request body>` using the connection's signing secret.

Verify the signature against the raw bytes using a constant-time comparison, reject timestamps outside your chosen replay window (for example five minutes), and deduplicate the delivery ID. Each retry gets a fresh timestamp and signature.

## API routes

All routes use dashboard sessions and CSRF protection for writes, and return `Cache-Control: no-store`.

| Route | Access |
| --- | --- |
| `GET`, `PUT /api/v1/admin/email` | Instance admin |
| `POST /api/v1/admin/email/test` | Instance admin |
| `GET /api/v1/admin/email/deliveries` | Instance admin |
| `GET`, `POST /api/v1/projects/:id/notification-channels` | `settings.manage` |
| `PATCH /api/v1/projects/:id/notification-channels/:channel` | `settings.manage`; change `enabled` |
| `POST /api/v1/projects/:id/notification-channels/:channel/test` | `settings.manage` |
| `GET`, `POST /api/v1/projects/:id/alert-rules` | `settings.manage` |
| `PUT /api/v1/projects/:id/alert-rules/:rule` | `settings.manage` |
| `GET /api/v1/projects/:id/notification-deliveries` | `settings.manage` |

SMTP writes use `host`, `port`, `security` (`tls` or `starttls`), `username`, optional `password`, `from`, `fromName`, and `enabled`. Tests use `recipient`. Connection creation uses `name`, `kind` (`email`, `slack`, `webhook`), `destination`, and `signingSecret` for generic webhooks. Rule creation/update uses `name`, `channelId`, `trigger` (`new_issue`, `regression`, or `slow_query`), `cooldownMinutes`, and `enabled`. Slow-query rules additionally require `thresholdMs` and accept optional `environment` and `queryName` strings of 1–128 characters. Omit empty filters. Query-specific fields are rejected for issue rules. Updates replace the rule configuration; omitted filters are cleared.
