# Contributing to Jekimo

Thank you for your interest in Jekimo. This document explains how to propose changes and what we expect from contributions. By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Project status

Jekimo is working toward its first release. A first vertical slice runs end to end: instance setup, sessions, projects, ingestion keys, `POST /api/v1/ingest`, a durable PostgreSQL queue, the worker, and the event query API, plus an alpha of the Node.js SDK. The dashboard, rate limits and quotas, invitations, key rotation, disk-pressure handling, object storage, and the production deployment are not implemented yet. The product brief in the [README](README.md) describes the whole product. Contributions that are especially welcome:

- Feedback on the specs in [`docs/`](docs/README.md): the event envelope, ingestion protocol, retention, access model, and object storage.
- Design proposals for items listed under "Open decisions" in the README.
- Documentation improvements.
- Implementation work on the Phase 1 milestones, coordinated through an issue first.

## Where to start

- Browse the [Phase 1: Backend MVP milestone](https://github.com/bigbimbs/jekimo/milestone/1) for the work in progress toward the first release.
- New to the project? Pick an issue labelled [`good first issue`](https://github.com/bigbimbs/jekimo/labels/good%20first%20issue). Each one describes what to build and how to check it, and needs no database or running services unless it says so.
- Issues labelled [`needs design`](https://github.com/bigbimbs/jekimo/labels/needs%20design) need an agreed approach before code; comment on the issue or start a thread in [Ideas](https://github.com/bigbimbs/jekimo/discussions/categories/ideas).
- Comment on an issue to say you are working on it, so nobody duplicates your work.

## Before you start

1. **Search existing issues** to avoid duplicate work.
2. **Open an issue** describing the change you want to make before writing significant code. Small fixes (typos, broken links, obvious bugs) can go straight to a pull request.
3. For larger features or anything that changes the public event schema, API, or deployment contract, wait for a maintainer to confirm the approach before investing time.

## Development setup

Jekimo is a TypeScript monorepo using npm workspaces.

Requirements:

- Node.js 22.12 or newer (see [`.nvmrc`](.nvmrc))
- npm 10 or newer
- Docker with Compose v2, for the local stack and the PostgreSQL integration tests (see [Local development](#local-development))

```bash
git clone https://github.com/bigbimbs/jekimo.git
cd jekimo
npm install
npm run check   # lint, type check, and unit tests
```

Day-to-day commands, all run from the repository root:

| Command | What it does |
| --- | --- |
| `npm run lint` | Checks lint rules, formatting, and import order with [Biome](https://biomejs.dev/). Writes nothing. |
| `npm run lint:fix` | Applies Biome's safe fixes and formatting. |
| `npm run format` | Formats every file with Biome. |
| `npm run typecheck` | Type-checks every TypeScript project with `tsc -b`. |
| `npm test` | Runs the Vitest unit tests. |
| `npm run check` | Runs `lint`, `typecheck`, and `test` in that order, as CI does. |
| `npm run build --workspaces --if-present` | Builds every workspace that has a `build` script: `packages/event-schema` and `packages/storage-postgres` to `dist/` with `tsc -b`, `apps/api` and `apps/worker` to `dist/*.mjs` bundles with esbuild, and `packages/sdk-node` to its published `dist/`. |

Each app lives under `apps/` and each shared library under `packages/`. See the README in each directory for its purpose. Build output (`dist/`, `*.tsbuildinfo`) is ignored by git.

### Editor setup

Install the Biome extension for your editor; VS Code offers it automatically from [`.vscode/extensions.json`](.vscode/extensions.json). Enable format on save with Biome as the default formatter so your changes already match `npm run lint`. Disable Prettier and ESLint extensions for this workspace if you have them installed globally; the repository does not use them.

### TypeScript configuration

Shared compiler options live in [`tsconfig.base.json`](tsconfig.base.json): ES2022, NodeNext modules, `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `noEmit`. The root [`tsconfig.json`](tsconfig.json) is a solution file: it compiles nothing itself and lists each TypeScript project under `references`, so `tsc -b` checks them all. Root-level config files such as `vitest.config.ts` are covered by `tsconfig.config.json`.

Workspaces depend on each other through package names (`@jekimo/event-schema`, `@jekimo/storage-postgres/memory`) and project `references`; no tsconfig includes another workspace's `src/`. (The relative imports across workspaces, `apps/api/test/slice.test.ts` loading the worker and `apps/api/test/sdk.test.ts` loading the worker and the Node SDK, also resolve through the references to `apps/worker` and `packages/sdk-node`.) There are two kinds of project:

- **Libraries other workspaces import** (`packages/event-schema`, `packages/storage-postgres`, and `apps/worker` and `packages/sdk-node`, which `apps/api`'s end-to-end tests import). `tsconfig.json` covers `src/` only and emits to `dist/` (JavaScript, declarations, and source maps; `apps/worker` and `packages/sdk-node` emit declarations only, to `dist/types/`, since their runtime builds are esbuild bundles; the SDK's published declarations come from `tsconfig.build.json`). Tests have their own project in `test/tsconfig.json`, which references the package. Each `exports` entry in `package.json` of a library imported by package name lists three conditions in this order:

  ```json
  ".": {
    "@jekimo/source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
  ```

  `tsc -b` ignores `@jekimo/source` and resolves `types`, which it builds from the referenced project first. Vitest (`vitest.config.ts`), the esbuild app and SDK bundles, and `tsx` (`npm run dev`, `npm run migrate`) set the `@jekimo/source` condition and read the TypeScript sources directly, so tests, dev servers, and bundles need no prior build. Plain Node.js without the condition loads `dist/`.
- **Leaf projects** (`apps/api`) that nothing imports. `tsconfig.json` covers `src/` and `test/` and emits nothing.

When a workspace gets its first source file, wire it in within the same pull request:

1. Add `tsconfig.json` to the workspace. For a leaf project:

   ```json
   {
     "extends": "../../tsconfig.base.json",
     "compilerOptions": {
       "composite": true,
       "types": ["node"]
     },
     "include": ["src", "test"],
     "references": [{ "path": "../../packages/event-schema" }]
   }
   ```

   List every workspace it imports under `references`. Adjust `types` to what the workspace runs on (the dashboard will want DOM libraries rather than Node types). For a library, copy [`packages/storage-postgres/tsconfig.json`](packages/storage-postgres/tsconfig.json) and [`packages/storage-postgres/test/tsconfig.json`](packages/storage-postgres/test/tsconfig.json), add the three-condition `exports`, and add `"build": "tsc -b"` to its scripts.
2. Add `{ "path": "./apps/<name>" }` or `{ "path": "./packages/<name>" }` to `references` in the root `tsconfig.json`, plus `<path>/test` for a library.
3. Run `npm run check`. Biome and Vitest already pick up every workspace, so they need no changes.

`apps/web` has a placeholder `tsconfig.json` that checks no files; replace its `files` with `include` when the dashboard gets source.

## Local development

[docs/local-development.md](docs/local-development.md) walks through the whole stack step by step. In short, from the repository root:

1. Start PostgreSQL, the migrations, the API, and the worker. Every port binds to `127.0.0.1`, and `.env` is ignored by git:

   ```bash
   cp .env.example .env
   docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml up -d --build
   ```

2. Run setup. The API prints a one-time setup token to its log; post it to `/api/v1/setup` with a synthetic email, password, and project name. Setup creates the first instance admin, the first project, and its ingestion key, which the response shows once:

   ```bash
   docker compose --env-file .env -f deploy/docker-compose/docker-compose.dev.yml logs api | grep -A2 "setup token"
   curl -s -X POST http://127.0.0.1:8080/api/v1/setup \
     -H 'content-type: application/json' \
     -d '{"setup_token":"<token from the api logs>","email":"admin@example.test","password":"synthetic-password-123","project_name":"Billing API"}'
   ```

3. Keep the ingestion key from the setup response in `JEKIMO_KEY`, and sign in to get a session for reading events, as in the walkthrough.

4. Send a test event built from the synthetic examples in [`packages/event-schema/examples/`](packages/event-schema/examples/), with `project_id` removed because the server assigns it, then read it back with `GET /api/v1/projects/<project id>/events`:

   ```bash
   jq '{events: [del(.project_id)]}' packages/event-schema/examples/exception.json > events.json
   curl -s -X POST http://127.0.0.1:8080/api/v1/ingest \
     -H "authorization: Bearer $JEKIMO_KEY" -H 'content-type: application/json' \
     -d @events.json
   ```

With the stack running, `set -a; . ./.env; set +a; npm test` also runs the PostgreSQL integration tests. `docker compose ... down -v` removes the stack and its data.

## Making changes

- Create a branch from `main`: `git checkout -b feat/short-description` or `fix/short-description`.
- Keep pull requests focused on one change. Separate refactors from behavior changes.
- Follow the existing code style. Formatting and lint rules are enforced by Biome ([`biome.json`](biome.json)), which reads [`.editorconfig`](.editorconfig); run `npm run lint:fix` before committing. Suppress a rule only with a `biome-ignore` comment that states the reason.
- Add or update tests for behavior you change. Tests use [Vitest](https://vitest.dev/) and live in `test/` next to each package's `src/`.
- Update documentation under `docs/` and the relevant README when you change public behavior, configuration, or the event schema.
- Add an entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for user-visible changes. These entries become the release notes, so describe the change for people running Jekimo or using the SDK.
- If you change a workflow under `.github/workflows/`, run [`actionlint`](https://github.com/rhysd/actionlint) on it.

### Code organization

Keep declarations apart from behavior, so each workspace's shapes and fixed values can be found and reviewed in one place:

- **Types and interfaces** live in `src/types/`, one file per domain (for example `src/types/issue.ts`, `src/types/queue.ts`), re-exported from `src/types/index.ts`. These files contain only `interface` and `type` declarations, no runtime code.
- **Enumerations and other fixed values** live in `src/constants/`, one file per domain, re-exported from `src/constants/index.ts`. Write an enumeration as an `as const` array or object with its union type derived next to it, not as a TypeScript `enum`:

  ```ts
  // src/constants/issue.ts
  export const ISSUE_STATUSES = ["unresolved", "resolved", "ignored"] as const;
  export type IssueStatus = (typeof ISSUE_STATUSES)[number];
  ```

  `enum` emits runtime code that Node.js type stripping does not support, and a constant array also gives validators and tests the list of allowed values.
- **Implementation files** (routes, repositories, services, the worker) hold functions and classes and import the declarations they need with `import type`. They do not export types of their own.
- A type used only inside one file and never exported may stay in that file. Once a second file needs it, move it to `src/types/`.
- Public packages keep their entry point (`src/index.ts`) as the place that re-exports what consumers may use, including types and constants.

The API (`apps/api`, Fastify) is organized by module, one folder per area under `src/modules/` (for example `issues`, `members`, `keys`):

- `routes.ts` registers the area's routes as a Fastify plugin. It parses and validates the request, declares the credential and permission it needs, calls the service, and shapes the response. It holds no business logic and no storage calls beyond what the service exposes.
- `service.ts` holds the logic. It receives its dependencies (the storage boundaries, clocks, configuration) as arguments when it is created, so tests can pass in-memory doubles; there is no decorator-based injection.
- The area's declarations follow the rules above, in `src/types/` and `src/constants/`.
- Every project route declares its permission with the shared `requireProjectPermission` pre-handler (the equivalent of a guard), never by checking a role name.

### Comments

Keep comments few and short. Names and types should say what code does; a comment is for what they cannot:

- Write one when the reason is not visible in the code: a spec rule (cite the doc and section), a security or isolation constraint, a workaround, or a deliberate choice that looks wrong at first sight.
- Do not restate the code, narrate steps, label obvious blocks, or repeat a function's name and types in prose.
- Prefer a clearer name or a smaller function over a comment that explains a confusing one.
- A short doc comment on an exported function or type is welcome when its contract (units, ranges, side effects, what it throws) is not obvious from the signature.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(api): add project-scoped ingestion key validation
fix(sdk-node): bound the local event queue
docs: describe the backup procedure
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

### Pull requests

- Fill in the pull request template.
- Link the issue the pull request addresses.
- Make sure CI passes.
- A maintainer will review your change. Please respond to review comments; pull requests with no activity for 30 days may be closed.

## Releases

Maintainers cut releases by pushing tags: `vX.Y.Z` for Jekimo (GitHub Release and container images) and `sdk-node-vX.Y.Z` for the Node SDK on npm. Contributors do not need to bump versions or create tags. The versioning policy and checklist are in [docs/releasing.md](docs/releasing.md).

## Security and privacy rules

- **Never commit secrets** (API keys, database passwords, tokens). Use `.env.example` for placeholders; real `.env` files are ignored by git.
- **Never include real captured event payloads, stack traces, or personal data** in issues, tests, fixtures, or documentation. Use synthetic examples.
- Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Licensing

By contributing to Jekimo, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE) that covers the project. You confirm that you have the right to submit the work under that license.

## Getting help

Open a [discussion or issue](https://github.com/bigbimbs/jekimo/issues) if you have questions about contributing.
