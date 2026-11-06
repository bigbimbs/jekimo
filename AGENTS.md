# Guidance for AI coding agents

This file gives context to AI coding assistants (Claude Code, Cursor, GitHub Copilot, Codex, and similar tools) working in this repository. Human contributors should read [CONTRIBUTING.md](CONTRIBUTING.md); everything there applies to agents too.

## What this project is

Jekimo is an open-source, self-hosted error, crash, and log observability platform. One installation on a VPS serves multiple isolated projects. Read [README.md](README.md) for the product brief and [docs/architecture.md](docs/architecture.md) for the intended design.

## Current state

A first vertical slice is implemented: instance setup, sessions, projects, ingestion keys, `POST /api/v1/ingest`, a durable PostgreSQL queue, the worker, and the event query API. It spans `apps/api`, `apps/worker`, `packages/storage-postgres`, and `packages/event-schema`, and runs locally with `deploy/docker-compose/docker-compose.dev.yml` ([docs/local-development.md](docs/local-development.md)). Not implemented yet: the dashboard (`apps/web`), rate limits and quotas, invitations and password reset, key rotation and revocation endpoints, custom role management, daily counters, disk-pressure handling, object storage, and the production deployment. Do not describe features as implemented unless the code exists in this repository.

Storage rules to keep: only `packages/storage-postgres` writes SQL; project data is reached through a `ProjectAccess` from `resolveProjectAccess`; the event store (`EventStore`) and metadata (`MetadataRepository`) are separate boundaries with no transaction spanning them; appends are idempotent on `(project_id, event_id)`; issue counts are derived from the event store.

## Repository layout

- `apps/api` — Node.js/TypeScript ingestion, project, and query API
- `apps/worker` — asynchronous event processing (validation, redaction, fingerprinting, retention)
- `apps/web` — React/TypeScript dashboard
- `packages/event-schema` — versioned event envelope shared by services and SDKs
- `packages/sdk-node` — Node.js SDK
- `packages/storage-postgres` — PostgreSQL storage boundary and migrations
- `deploy/docker-compose` — VPS deployment
- `docs/` — operator and contributor documentation

## Rules that must not be broken

1. **Project isolation is a hard requirement.** Every event, query, export, and issue action is scoped to a project on the server. Never let a client choose a project by changing an ID in a request.
2. **Secrets stay secret.** Ingestion keys and database passwords are shown once at creation or rotation, never logged, never echoed back by the UI, and never used to grant dashboard access. Setup-time administrator database credentials are not retained at runtime.
3. **Safe by default.** SDKs do not collect request bodies, credentials, or personal data unless configured to. Redaction happens before transmission.
4. **Low impact.** SDKs send asynchronously, bound memory, and never block application requests.
5. **The specs in `docs/` are normative.** `docs/event-format.md`, `docs/ingestion-protocol.md`, `docs/retention.md`, `docs/access-model.md`, and `docs/object-storage.md` define the contracts. Any change to them must land in the same pull request as matching changes to the types, validator, JSON Schema, examples, and tests in `packages/event-schema`.
6. **No real data in the repo.** Tests, fixtures, docs, and examples use synthetic payloads only.

## Conventions

- TypeScript with `strict` enabled; see the root `tsconfig.json`.
- npm workspaces; run commands from the repository root.
- Conventional Commits for commit messages.
- Update `CHANGELOG.md` under "Unreleased" for user-visible changes.
- Update the relevant `docs/` page when behavior, configuration, or deployment changes.
- Prefer small, focused pull requests.

## Commands

```bash
npm install        # install workspace dependencies
npm run typecheck  # TypeScript type check across apps and packages
npm test           # Vitest unit tests; PostgreSQL integration tests run when DATABASE_URL is set
npm run check      # both of the above
npm run migrate -w @jekimo/storage-postgres   # apply migrations to DATABASE_URL
npm run build --workspaces --if-present       # bundle apps/api and apps/worker into dist/
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml up -d --build   # local stack
```

Lint commands will be added here as they are introduced.

## Local agent configuration

Personal agent settings (for example `.claude/settings.local.json`) are ignored by git. Do not commit them.
