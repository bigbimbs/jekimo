# Contributing to Jekimo

Thank you for your interest in Jekimo. This document explains how to propose changes and what we expect from contributions. By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Project status

Jekimo is at the **scaffold stage**. The product brief in the [README](README.md) describes what we are building; the services, SDK, and deployment are not implemented yet. Early contributions that are especially welcome:

- Feedback on the event envelope, ingestion protocol, and access model in the brief.
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
- Docker and Docker Compose (for the deployment and storage packages, once implemented)

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

Each app lives under `apps/` and each shared library under `packages/`. See the README in each directory for its purpose. A build command will be added to the root `package.json` when the first package needs one.

### Editor setup

Install the Biome extension for your editor; VS Code offers it automatically from [`.vscode/extensions.json`](.vscode/extensions.json). Enable format on save with Biome as the default formatter so your changes already match `npm run lint`. Disable Prettier and ESLint extensions for this workspace if you have them installed globally; the repository does not use them.

### TypeScript configuration

Shared compiler options live in [`tsconfig.base.json`](tsconfig.base.json): ES2022, NodeNext modules, `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`. The root [`tsconfig.json`](tsconfig.json) is a solution file: it compiles nothing itself and lists each TypeScript project under `references`, so `tsc -b` checks them all. Root-level config files such as `vitest.config.ts` are covered by `tsconfig.config.json`.

When a workspace gets its first source file, wire it in within the same pull request:

1. Add `tsconfig.json` to the workspace:

   ```json
   {
     "extends": "../../tsconfig.base.json",
     "compilerOptions": {
       "composite": true,
       "types": ["node"]
     },
     "include": ["src", "test"]
   }
   ```

   Adjust `types` to what the workspace runs on (the dashboard will want DOM libraries rather than Node types). If it imports another workspace, add that workspace to its own `references`.
2. Add `{ "path": "./apps/<name>" }` or `{ "path": "./packages/<name>" }` to `references` in the root `tsconfig.json`.
3. Run `npm run check`. Biome and Vitest already pick up every workspace, so they need no changes.

## Making changes

- Create a branch from `main`: `git checkout -b feat/short-description` or `fix/short-description`.
- Keep pull requests focused on one change. Separate refactors from behavior changes.
- Follow the existing code style. Formatting and lint rules are enforced by Biome ([`biome.json`](biome.json)), which reads [`.editorconfig`](.editorconfig); run `npm run lint:fix` before committing. Suppress a rule only with a `biome-ignore` comment that states the reason.
- Add or update tests for behavior you change. Tests use [Vitest](https://vitest.dev/) and live in `test/` next to each package's `src/`.
- Update documentation under `docs/` and the relevant README when you change public behavior, configuration, or the event schema.
- Add an entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

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

## Security and privacy rules

- **Never commit secrets** (API keys, database passwords, tokens). Use `.env.example` for placeholders; real `.env` files are ignored by git.
- **Never include real captured event payloads, stack traces, or personal data** in issues, tests, fixtures, or documentation. Use synthetic examples.
- Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Licensing

By contributing to Jekimo, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE) that covers the project. You confirm that you have the right to submit the work under that license.

## Getting help

Open a [discussion or issue](https://github.com/bigbimbs/jekimo/issues) if you have questions about contributing.
