# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Event envelope v1 contract: normative spec in `docs/event-format.md`, published JSON Schema, zero-dependency reference validator (`validateEvent`) with ingest and stored modes, default redaction key list, example payloads, and a test suite that keeps spec, schema, and validator in agreement.
- Test tooling: Vitest with `npm test`, run in CI alongside the type check.
- Repository scaffold: monorepo layout, product brief, contributor documentation, issue and pull request templates, and CI workflow.
- Apache License 2.0.

[Unreleased]: https://github.com/bigbimbs/jekimo/commits/main
