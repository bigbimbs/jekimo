# Dashboard navigation

Selecting a project opens `/projects/:id/dashboard`. The project root redirects there. The navigation keeps four views separate:

- **Dashboard:** counts of stored records for the last 24 hours, split into exceptions, logs, and custom events; hourly activity; severity totals; and the five most recently seen unresolved issue groups. The counts come from the event store's summary query, not a loaded page or the ingestion counters. Refresh updates the time window. Empty activity is distinct from a failed request, which offers a retry.
- **Issues** (`/projects/:id/issues`): records grouped by fingerprint for investigation and status management. Existing groups can include exceptions, logs, and custom events; the kind filter narrows them. Resolving an issue does not delete its records from the explorers or summary.
- **Logs** (`/projects/:id/logs`): individual records with `kind=log`, newest receipt first.
- **Events** (`/projects/:id/events`): individual custom application records with `kind=event`, newest receipt first. This view excludes logs and exceptions; exceptions remain available through their issue details.

Logs and events support message-word search, exact environment matching, severity, and 1-hour, 24-hour, 7-day, or 30-day receipt windows. Filters stay in the URL. The selected window stays fixed while loading additional cursor pages; Refresh starts a new window. Click a message to open the record's detail path beneath its explorer, including timestamps, service, environment, release, context, attributes, and stored payload. Expired records show a not-found state. All requests use the API's project access check.

Dashboard counts cover receipt time `[from, to)` and are grouped into UTC hours; first and last hours can be partial. The browser displays timestamps in its locale and timezone. Sampled, rejected, and expired records are not stored and do not contribute. Counts and issue metadata are separate reads, so the worker can update them at slightly different times.

The selected theme also controls native dropdown menus and date inputs. Option backgrounds and text use the same light/dark palette as the rest of the dashboard.


## Instance administration

Instance admins open **Users**, **Invitations**, and **Audit log** from the account menu. These pages share administration navigation and are separate from project membership management.

- **Users** (`/admin/users`): search by email, filter by instance role or account status, change roles, deactivate/reactivate accounts, and generate password-reset links. Role changes and account status changes require confirmation. Deactivation ends all sessions; reactivation restores access through existing memberships. The API always protects the last active admin, even if the UI's list is stale. Changing your own role or deactivating your own account clears privileged cached data and leaves administration.
- **Invitations** (`/admin/invitations`): list pending invitations with expiry times, invite by email and instance role (Member by default), or confirm revocation. A new invitation to the same email replaces the previous unused link. Accepted, revoked, and expired invitations are not listed. New members still need to be added to projects through the Members page.
- **One-time links**: invitation and password-reset links are displayed only after creation. Copy them before closing the dialog and share privately with their intended recipient. Relative links are expanded to the dashboard origin; configured absolute public URLs are preserved. Clipboard failures allow manual copying. Links remain in component state only, are not stored in query/mutation caches or browser storage, and leave the UI on close/navigation. Creation responses use `Cache-Control: no-store`. No email is sent.

Password-reset links replace earlier unused reset links. Completing a reset ends the user's sessions but does not remove two-factor authentication. User changes, invitation creation/revocation, and password-reset link creation use the existing audited API actions, without storing the links in audit details. Admin-only API checks and enforced 2FA still apply to every operation.

The audit viewer uses actor/account emails, invitation recipient emails, readable target types, and available project names. Name lookups reflect current accounts/projects; removed or unavailable records have explicit fallback labels. Raw actor, target, and project identifiers remain available inside each row’s Details.

## Notifications

Instance administrators configure SMTP at `/admin/email`. Project users with `settings.manage` configure email, Slack, and signed webhooks at `/projects/:projectId/integrations`, and basic issue alerts at `/projects/:projectId/alerts`. Both project pages include delivery history. See [notifications.md](notifications.md).

## Cron jobs

`/projects/:projectId/cron` shows monitor health, next expected starts, last successes, and run history. Project settings managers can add monitors, select notification connections, and pause/resume monitoring. See [cron monitoring](cron-monitoring.md).

## Database query monitoring

Explicit query capture and callback instrumentation feed the project Database page with durations, failures, slow-query counts, and percentiles. No SQL, parameters, results, or exception messages are collected by the helpers. See [database monitoring](database-monitoring.md) for setup, API filters, privacy, and current scope.
