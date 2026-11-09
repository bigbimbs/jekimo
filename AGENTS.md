# Guidance for AI coding agents

This file gives context to AI coding assistants (Claude Code, Cursor, GitHub Copilot, Codex, and similar tools) working in this repository. Human contributors should read [CONTRIBUTING.md](CONTRIBUTING.md); everything there applies to agents too.

## What this project is

Jekimo is an open-source, self-hosted error, crash, and log observability platform. One installation on a VPS serves multiple isolated projects. Read [README.md](README.md) for the product brief and [docs/architecture.md](docs/architecture.md) for the intended design.

## Current state

A first vertical slice is implemented: instance setup, sessions, invitations and password reset links without email, instance user administration, projects and memberships, ingestion key issuance, rotation, and revocation, the audit log, `POST /api/v1/ingest` with per-project rate limits and daily quotas, a durable PostgreSQL queue, the worker with disk-safety checks and emergency expiry, the event query API, the issue API (list, detail, resolve, ignore, reopen), per-project NDJSON export streamed from the API, and the dashboard (`apps/web`: setup, sign-in, invitation and reset links, project switcher, issue list and detail, ingestion keys). It spans `apps/api`, `apps/worker`, `apps/web`, `packages/storage-postgres`, and `packages/event-schema`, and runs locally with `deploy/docker-compose/docker-compose.dev.yml` ([docs/local-development.md](docs/local-development.md)). Not implemented yet: dashboard pages for members, users, invitations, and the audit log (the API has them), custom role management, project deletion and restore, emailing invitations over SMTP, API endpoints for daily counters and redaction rules (the worker and ingest fill the counters and the worker applies the rules), object storage, and the production deployment. Do not describe features as implemented unless the code exists in this repository.

Storage rules to keep: only `packages/storage-postgres` writes SQL; project data is reached through a `ProjectAccess` from `resolveProjectAccess`; the event store (`EventStore`) and metadata (`MetadataRepository`) are separate boundaries with no transaction spanning them; appends are idempotent on `(project_id, event_id)`; issue counts are derived from the event store.

The Node.js SDK `@jekimo/sdk-node` exists as an alpha in `packages/sdk-node`; it is built and packed in CI but not yet published to npm.

## Repository layout

- `apps/api` — Node.js/TypeScript ingestion, project, and query API
- `apps/worker` — asynchronous event processing (validation, redaction, fingerprinting, retention)
- `apps/web` — React/TypeScript dashboard
- `packages/event-schema` — versioned event envelope shared by services and SDKs
- `packages/sdk-node` — Node.js SDK, published as `@jekimo/sdk-node`; bundles `@jekimo/event-schema` at build time and has no runtime dependencies
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

- TypeScript with `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` enabled; shared options live in `tsconfig.base.json`.
- npm workspaces; run commands from the repository root.
- Conventional Commits for commit messages.
- Update `CHANGELOG.md` under "Unreleased" for user-visible changes.
- Update the relevant `docs/` page when behavior, configuration, or deployment changes.
- Prefer small, focused pull requests.
- Declarations live in their own files: interfaces and type aliases in `src/types/<domain>.ts`, enumerations and fixed values in `src/constants/<domain>.ts` as `as const` arrays or objects with a derived union type (never TypeScript `enum`). Implementation files import them with `import type` and do not export types. See "Code organization" in [CONTRIBUTING.md](CONTRIBUTING.md).
- Minimal comments: comment only the why that the code cannot show (a spec rule with its doc section, a security constraint, a workaround). Never restate what the code does. See "Comments" in [CONTRIBUTING.md](CONTRIBUTING.md).

## Releases

Releases are cut by maintainers by pushing tags; the process is in [docs/releasing.md](docs/releasing.md).

- Never create tags, GitHub Releases, container images, or npm publishes. A `v*` tag runs `.github/workflows/release.yml` and `.github/workflows/images.yml`; an `sdk-node-v*` tag runs `.github/workflows/publish-sdk.yml`.
- The Jekimo version, the `@jekimo/sdk-node` version, the envelope `schema_version`, and the API path version (`/api/v1`) are independent. Do not bump one because another changed.
- Changelog entries go under "Unreleased". The release workflow takes the release notes from the version's section and fails if it is missing, so write entries for operators and SDK users, not for reviewers.
- In workflows, keep top-level `permissions` read-only and grant write scopes per job, pin actions by major version, and check changes with [`actionlint`](https://github.com/rhysd/actionlint).

## Commands

```bash
npm install        # install workspace dependencies
npm run lint       # Biome lint, format, and import-order check (no writes)
npm run lint:fix   # apply Biome's safe fixes and formatting
npm run format     # format every file with Biome
npm run typecheck  # tsc -b over the solution tsconfig and its project references
npm test           # Vitest unit tests; PostgreSQL integration tests run when JEKIMO_DATABASE_URL is set
npm run check      # lint, typecheck, then test; CI runs the same three steps
npm run migrate -w @jekimo/storage-postgres   # apply migrations to JEKIMO_DATABASE_URL
npm run build --workspaces --if-present       # build libraries, app bundles, and the SDK into dist/
docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml up -d --build   # local stack
```

Biome (`biome.json`) is the only linter and formatter; do not add ESLint or Prettier. Run `npm run lint:fix` before committing. Each package with source has its own `tsconfig.json` that extends `tsconfig.base.json` and is listed in the root `tsconfig.json` references. Import another workspace by its package name and add it to `references`; never add another workspace's `src/` to a tsconfig `include`. `packages/event-schema` and `packages/storage-postgres` build to `dist/` and export an `@jekimo/source` condition that Vitest, esbuild, and `tsx` use, so nothing needs building before tests or bundles. See "TypeScript configuration" in [CONTRIBUTING.md](CONTRIBUTING.md).

## Local agent configuration

Personal agent settings (for example `.claude/settings.local.json`) are ignored by git. Do not commit them.
