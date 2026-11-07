# Security policy

Jekimo handles error reports, stack traces, and logs, which can contain sensitive data. We take security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Report them privately using one of these channels:

1. **GitHub private vulnerability reporting (preferred):** open the [Security tab](https://github.com/bigbimbs/jekimo/security/advisories/new) of this repository and click "Report a vulnerability".
2. **Email:** <bamidayo10@gmail.com> with the subject line `[Jekimo security]`.

Please include:

- A description of the issue and its potential impact.
- Steps to reproduce, or a proof of concept.
- The affected version or commit, and your environment.
- Any suggested mitigation, if you have one.

Never include real credentials, personal data, or real captured event payloads in a report. Use synthetic data to demonstrate the problem.

## What to expect

- We aim to acknowledge your report within **3 business days**.
- We will keep you informed about progress toward a fix and a coordinated disclosure date.
- We will credit you in the release notes when the fix ships, unless you prefer to remain anonymous.

## Supported versions

Jekimo has not had a stable release yet. Until `1.0.0`:

| Version | Supported |
| --- | --- |
| `main` branch | Yes |
| Latest `0.x` pre-release | Yes |
| Older `0.x` pre-releases | No. Upgrade to the latest pre-release. |

Fixes land on `main` and ship in the next `0.x` release; earlier `0.x` releases are not patched. The same applies to `@jekimo/sdk-node`: only its latest published version is supported.

From `1.0.0` on, the latest minor release is supported, and the previous minor release keeps receiving security fixes for **90 days** after the next minor is released. Release notes state the end-of-support date for the previous minor. See [docs/releasing.md](docs/releasing.md) for the versioning policy.

## Scope

In scope:

- The Jekimo API, worker, web dashboard, SDKs, and storage packages in this repository.
- The Docker Compose deployment files under `deploy/`.

Out of scope:

- Vulnerabilities in third-party dependencies that have already been reported upstream. Please report those to the dependency's maintainers; a pull request bumping the dependency is welcome.
- Issues that require physical access to the operator's VPS or a compromised operator account.
