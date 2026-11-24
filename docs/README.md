# Documentation

Specs marked **normative** define contracts that the code in `packages/event-schema` must match; changes to them land in the same pull request as the matching code and tests (see [AGENTS.md](../AGENTS.md)).

## Contracts (normative)

- [event-format.md](event-format.md): the versioned event envelope, field rules, size limits, privacy defaults, and compatibility rules.
- [ingestion-protocol.md](ingestion-protocol.md): the `POST /api/v1/ingest` endpoint, ingestion keys, batching, responses, rate limits, and SDK retry rules.
- [retention.md](retention.md): retention periods, expiry, quotas, sampling, disk-pressure safeguards, deletion, and first-release sizing.
- [access-model.md](access-model.md): instance roles, project permissions and roles, authentication, authorization enforcement, audit log, and setup flow.
- [object-storage.md](object-storage.md): the optional S3-compatible cold tier, archive format, backups, and exports.

## Design

- [architecture.md](architecture.md): event flow, why PostgreSQL first, the event store design rules that keep ClickHouse an option, and deployment shape.
- [database-setup.md](database-setup.md): existing-database and local-provisioning setup flows, database accounts and privileges, pre-flight checks, rollback, how administrator credentials are kept out of the instance, TLS, and credential rotation.

## Operating an instance

- [request-tracing.md](request-tracing.md): PostgreSQL instrumentation, request correlation, and trace lookup.

- [database-monitoring.md](database-monitoring.md): query instrumentation, performance metrics, privacy, and current limits.

- [cron-monitoring.md](cron-monitoring.md): scheduled-job check-ins, health, timeouts, run history, and notifications.

- [notifications.md](notifications.md): SMTP setup, project integrations, basic issue alerts, delivery history, and webhook verification.

- [Dashboard navigation](dashboard.md): overview counts, separate logs and custom events, filters, and record details.

- [two-factor-authentication.md](two-factor-authentication.md): authenticator enrollment, optional and required 2FA, operator recovery, encryption-key handling, and the audit dashboard.

- [install-vps.md](install-vps.md): installing Jekimo on a VPS with the production Docker Compose file and Caddy, from an empty server to HTTPS, setup, a first event, backups, and upgrades.
- [configuration.md](configuration.md): every setting, its default, valid values, which service reads it, and whether it is implemented or planned.
- [backups-and-restore.md](backups-and-restore.md): taking a backup, copying it off the server, restoring into a fresh database, and the monthly restore drill.

## Maintaining the project

- [releasing.md](releasing.md): versioning policy, release workflows, the release checklist, one-time npm and GitHub setup, and how to yank or hotfix a release.
