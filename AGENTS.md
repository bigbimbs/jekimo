# Guidance for AI coding agents

This file gives context to AI coding assistants (Claude Code, Cursor, GitHub Copilot, Codex, and similar tools) working in this repository. Human contributors should read [CONTRIBUTING.md](CONTRIBUTING.md); everything there applies to agents too.

## What this project is

Jekimo is an open-source, self-hosted error, crash, and log observability platform. One installation on a VPS serves multiple isolated projects. Read [README.md](README.md) for the product brief and [docs/architecture.md](docs/architecture.md) for the intended design.

## Current state

The repository is a scaffold. The implemented code is the contract-level helpers in `packages/event-schema` (envelope validation, ingestion request validation, retention and sampling helpers) and an alpha of the Node.js SDK in `packages/sdk-node` (envelope building, redaction, batching, retries, crash capture), tested against a mocked transport only; the API, worker, dashboard, storage, and deployment are not written yet. Do not describe features as implemented unless the code exists in this repository.

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

## Commands

```bash
npm install        # install workspace dependencies
npm run lint       # Biome lint, format, and import-order check (no writes)
npm run lint:fix   # apply Biome's safe fixes and formatting
npm run format     # format every file with Biome
npm run typecheck  # tsc -b over the solution tsconfig and its project references
npm test           # Vitest unit tests
npm run check      # lint, typecheck, then test; CI runs the same three steps
```

Biome (`biome.json`) is the only linter and formatter; do not add ESLint or Prettier. Run `npm run lint:fix` before committing. Each package with source has its own `tsconfig.json` that extends `tsconfig.base.json` and is listed in the root `tsconfig.json` references; see "TypeScript configuration" in [CONTRIBUTING.md](CONTRIBUTING.md). A build command will be added here when the first package needs one.

## Local agent configuration

Personal agent settings (for example `.claude/settings.local.json`) are ignored by git. Do not commit them.
