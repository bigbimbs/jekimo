# Jekimo

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/bigbimbs/jekimo/actions/workflows/ci.yml/badge.svg)](https://github.com/bigbimbs/jekimo/actions/workflows/ci.yml)
[![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange.svg)](#repository-layout)

Jekimo is an open-source error and event observability platform. It helps teams capture backend exceptions, application errors, crashes, and structured logs, then search and investigate them in one place.

The project starts with backend services. A user should be able to install one Jekimo instance on a VPS and use that instance to monitor multiple projects. Mobile and browser application support is planned for a later phase.

## What it should do

- Capture unhandled exceptions and explicitly reported errors.
- Accept structured application logs and contextual events.
- Group repeated errors into issues and preserve stack traces and useful request or release context.
- Let a team search, filter, and inspect events through an API and a web interface.
- Give operators control over retention, sampling, redaction, and data export.
- Run on a VPS as a self-hosted service, with clear deployment, backup, and upgrade instructions.
- Support multiple users and projects in one installation, with project-scoped credentials and strict data isolation.

## Initial scope

The first usable release should focus on Node.js services and a small, reliable event pipeline:

1. A backend SDK that reports exceptions, logs, and custom events without blocking application requests.
2. An ingestion API that authenticates projects, validates and limits payloads, and acknowledges accepted events.
3. An instance admin and project management flow so users can create several projects in one installation.
4. A durable queue or buffer between ingestion and storage so short storage interruptions do not lose accepted events.
5. Storage for event payloads and issue summaries, with indexes for time, project, severity, and fingerprint.
6. A basic interface or API for finding events, viewing stack traces, and marking issues resolved.

Mobile and browser SDKs, alerting, advanced dashboards, and distributed tracing are later milestones. The event schema and ingestion protocol should allow those clients to be added without changing the core backend pipeline.

## Language and how people use it

Build Jekimo primarily in **TypeScript**. Node.js is the runtime for the ingestion service and the first backend SDK; TypeScript is the language used to write that code. Build the project dashboard with React and TypeScript, then serve it from the VPS so users can sign in from a browser, create or switch projects, and inspect errors, crashes, and logs. Users will access the running Jekimo instance through its web address; they do not need to read or run the source code to use it. The source remains available for developers who want to inspect, modify, or contribute to the project.

## Self-hosted multi-project model

One Jekimo installation is a private monitoring service for its operator. It contains multiple projects, and each project has its own name, platform, environment configuration, event data, and ingestion key. The web interface lets an authenticated user switch between projects and inspect only projects they are permitted to access. Every stored event and query is scoped to a project on the server; clients cannot choose another project merely by changing an ID in a request.

For the first release, target a single VPS installation using Docker Compose, with documented domain/HTTPS setup, persistent volumes, backup and restore, and upgrade steps. During setup, let the operator either connect an existing supported database or have Jekimo provision a database on that VPS. Keep the service usable without a hosted Jekimo account. Support instance administrators and project-level access as the design grows; avoid making a public multi-customer hosted service a prerequisite for the self-hosted MVP.

Project ingestion keys are secrets: show them only at creation or rotation, allow revocation, and never use them to grant access to the user interface. Add configurable per-project event limits and retention so one noisy project cannot exhaust the whole VPS. Make resource needs and the consequences of disk exhaustion visible in the install guide.

### Database setup options

The operator chooses a supported database setup during installation:

1. **Connect an existing database:** enter the datasource connection details and credentials for a database the operator controls. It may be on the same VPS or reachable on another host.
2. **Provision a local database:** let the installer run PostgreSQL on the same VPS through Docker Compose and initialize Jekimo's database and a dedicated application account. If the operator already has a local PostgreSQL server, setup can instead use administrator credentials once to create the database and restricted account there. The running service uses only the dedicated account; it must not retain or use administrator credentials during normal operation.

Start with PostgreSQL as the supported database engine in both paths. Keep connection configuration behind a storage boundary so additional engines can be considered later. Treat database passwords as secrets: do not expose them in logs, show them back in the interface, or store them unprotected. Document the required database privileges, TLS options, backup and restore procedure, and how to rotate credentials. Validate connectivity and permissions before completing setup, and fail with a clear message without leaving a partially provisioned installation.

## Design principles

- **Safe by default:** redact configured secrets and sensitive fields before transmission; document exactly what is collected.
- **Low impact:** SDKs buffer and send asynchronously, have bounded memory use, and never make application work wait on the observability service.
- **Useful context:** capture stack traces, timestamps, environment, release, service, and trace or request identifiers when available.
- **Open and portable:** publish the event schema and API; support self-hosting and data export.
- **Honest delivery guarantees:** distinguish an event created locally, accepted by ingestion, and durably stored.
- **Incremental clients:** keep the event contract stable while adding runtime, browser, and mobile SDKs over time.
- **Self-hosted by design:** a single VPS operator can manage multiple isolated projects without depending on a Jekimo cloud account.

## Event envelope

Every event shares a versioned envelope, regardless of whether it came from a backend, browser, or mobile SDK. The full contract, with field rules, limits, privacy defaults, and compatibility rules, is in [docs/event-format.md](docs/event-format.md), and the HTTP protocol for sending events is in [docs/ingestion-protocol.md](docs/ingestion-protocol.md); the types, JSON Schema, and reference validator live in [`packages/event-schema`](packages/event-schema). A representative event:

```json
{
  "schema_version": 1,
  "event_id": "01J...",
  "project_id": "project-id",
  "timestamp": "2026-11-02T10:00:00Z",
  "kind": "exception",
  "severity": "error",
  "message": "Database request failed",
  "service": "billing-api",
  "environment": "production",
  "release": "1.4.2",
  "fingerprint": "stable-grouping-key",
  "exception": {
    "type": "DatabaseError",
    "stacktrace": "..."
  },
  "context": {
    "request_id": "..."
  },
  "attributes": {}
}
```

The SDK must avoid collecting request bodies, credentials, or personal data by default. Projects can configure field redaction and size limits. The envelope is a public compatibility contract; changes follow the rules in the event format document.

## Suggested architecture

```text
Backend SDKs
    -> authenticated ingestion API
    -> bounded durable queue
    -> event processor (validation, redaction, fingerprinting)
    -> event store and issue index
    -> query API and web interface
```

Keep ingestion separate from querying and issue management. This allows SDK traffic to be handled independently from interactive searches. Begin with a single-node deployment that can be installed on a VPS and supports multiple projects. Add distributed components only when measured needs justify them. Enforce project scoping in the ingestion credential, storage queries, search API, exports, and issue actions.

## Roadmap

### Phase 0 — Define the contract

- ~~Choose the project license.~~ Done: Apache-2.0.
- ~~Specify event envelope, payload limits, and redaction defaults.~~ Done: [docs/event-format.md](docs/event-format.md).
- ~~Specify ingestion authentication, batching, and limits.~~ Done: [docs/ingestion-protocol.md](docs/ingestion-protocol.md).
- ~~Specify retention behavior.~~ Done: [docs/retention.md](docs/retention.md).
- ~~Define instance, user, and project ownership and access rules.~~ Done: [docs/access-model.md](docs/access-model.md).
- ~~Choose a storage approach and document the expected VPS resource range.~~ PostgreSQL; proposed range in [docs/retention.md](docs/retention.md).
- ~~Define the existing-database and local-provisioning setup flows, including the one-time administrator credential handling.~~ Done: [docs/database-setup.md](docs/database-setup.md).

### Phase 1 — Backend MVP

- Publish one backend SDK for exceptions, logs, and custom events.
- Package the service for Docker Compose installation on one VPS.
- Build project management, project-scoped ingestion keys, authenticated ingestion, validation, rate limits, and durable processing.
- Add issue grouping, search, and a minimal issue detail view.
- Ensure users can switch between projects while keeping event data isolated.
- Provide local development setup, VPS deployment and backup documentation, and per-project export.

### Phase 2 — Production readiness

- Add alert rules, retention controls, project management, and operational metrics.
- Add the optional object storage cold tier, bucket backups, and bucket exports ([docs/object-storage.md](docs/object-storage.md)).
- Add ClickHouse as an opt-in event store for operators with high log volume, behind the same event store boundary.
- Document delivery semantics, scaling guidance, backups, and upgrades.
- Add SDKs for additional backend languages based on contributor demand.

### Phase 3 — Browser and mobile

- Add browser and mobile SDKs using the same event envelope.
- Add source maps and native symbolication as separate, opt-in capabilities.
- Review privacy, consent, network, and battery impact for client-side capture.

## Decisions so far

- First SDK target: Node.js (TypeScript).
- Database engine for the first release: PostgreSQL only. The event store sits behind its own boundary and is designed so ClickHouse can be offered as an opt-in event store for high log volume in Phase 2; see the storage engines section of [docs/architecture.md](docs/architecture.md).
- License: Apache-2.0.
- Users and roles: multiple users per instance with instance roles (`admin`, `member`). Inside a project, access is permission-based: every project starts with built-in `admin`, `member`, and `viewer` roles, and custom roles can be composed from the permission catalogue. See [docs/access-model.md](docs/access-model.md).
- Retention: 30 days by default per project, measured from receipt, with quotas, optional deterministic sampling, and disk-pressure safeguards. See [docs/retention.md](docs/retention.md).
- Object storage: optional, S3-compatible (Cloudflare R2, S3, Backblaze B2, MinIO, or a local directory), used as a cold tier for old events, for backups, and for exports. PostgreSQL stays the hot, searchable store. Planned for Phase 2. See [docs/object-storage.md](docs/object-storage.md).
- Proposed first-release target: a 2 vCPU, 4 GB RAM, 80 GB SSD VPS handling 1,000,000 events a month at 30-day retention. To be confirmed by measurement in Phase 1.

## Open decisions

- Whether to offer per-kind retention (for example, exceptions kept longer than logs) in the first release.
- Teams or groups for granting many users access to many projects at once.

## Repository layout

The repository is a TypeScript monorepo using npm workspaces.

| Path | Contents | State |
| --- | --- | --- |
| `apps/api` | Fastify API: setup, sessions, projects, ingestion keys, `POST /api/v1/ingest`, the event query API, and the issue API | Vertical slice |
| `apps/worker` | Queue consumer: sampling, redaction, fingerprinting, event storage, issue summaries, and expiry | Vertical slice |
| `apps/web` | React dashboard: setup, sign-in, invitation and reset links, project switcher, issue list and detail, ingestion keys; light and dark themes | First pages |
| `packages/event-schema` | Event envelope v1, ingestion protocol helpers, retention, sampling, and permission model | Implemented |
| `packages/storage-postgres` | Migrations, metadata repository, partitioned event store, and durable queue | Vertical slice |
| `packages/sdk-node` | Node.js SDK `@jekimo/sdk-node` 0.1.0-alpha.0 (built, not yet published) | Alpha |
| `deploy/docker-compose` | `docker-compose.dev.yml` for local development; the VPS deployment is still to come | Development only |
| `docs` | Specifications and operating guides | |

One thin path works end to end: create the first admin, sign in, create a project and an ingestion key, send an event, and read it back. [docs/local-development.md](docs/local-development.md) walks through it. Invitations, password reset links, memberships, key rotation and revocation, and the audit log are available through the API. Per-project rate limits and quotas and disk-safety checks are in place. The dashboard covers setup, sign-in, invitation and reset links, each project's issues, and ingestion keys; members, users, and the audit log are API-only for now.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and pull request process, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations, and [SECURITY.md](SECURITY.md) for how to report vulnerabilities privately. AI coding assistants should also read [AGENTS.md](AGENTS.md).

## License

Jekimo is licensed under the [Apache License 2.0](LICENSE).
