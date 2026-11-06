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
npm run check   # type check and unit tests
```

Each app lives under `apps/` and each shared library under `packages/`. See the README in each directory for its purpose. Build and lint commands will be added to the root `package.json` as the first implementation lands.

## Making changes

- Create a branch from `main`: `git checkout -b feat/short-description` or `fix/short-description`.
- Keep pull requests focused on one change. Separate refactors from behavior changes.
- Follow the existing code style. An [`.editorconfig`](.editorconfig) is provided; formatter and linter configuration will be added with the first implementation.
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
