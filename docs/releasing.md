# Releasing

This page is for maintainers. It describes how Jekimo is versioned, what each release workflow does, the checklist for cutting a release, and how to recover from a bad one.

Jekimo has not been released yet. The workflows below exist so the first release is a tag push, not a project.

## Versioning policy

- Jekimo follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
- Until the first stable release the version stays at `0.x`. In `0.x`, a minor bump (`0.2.0` to `0.3.0`) may contain breaking changes; release notes call them out under a **Breaking** heading.
- Pre-releases use a hyphenated suffix: `0.2.0-alpha.1`, `0.2.0-beta.1`, `0.2.0-rc.1`.
- `1.0.0` is the first stable release. From then on, breaking changes require a major version.
- Three version numbers are **independent** of each other:
  - The **Jekimo version** (`v0.2.0`): the server, worker, dashboard, container images, and docs. Kept in the root `package.json` and the `apps/*` and server-side `packages/*` manifests.
  - The **SDK version** (`sdk-node-v0.1.0`): `@jekimo/sdk-node` on npm, released on its own cadence. An SDK release does not imply a server release, and the other way round.
  - The **contract versions**: the event envelope `schema_version` ([event-format.md](event-format.md)) and the ingestion API path version `/api/v1` ([ingestion-protocol.md](ingestion-protocol.md)). These change only under the compatibility rules in those documents, never because a package version changed. A Jekimo release states which contract versions it accepts.

## Tags

| Tag | Example | Workflows triggered |
| --- | --- | --- |
| `vX.Y.Z` or `vX.Y.Z-pre.N` | `v0.2.0`, `v0.2.0-alpha.1` | [Release](../.github/workflows/release.yml), [Images](../.github/workflows/images.yml) |
| `sdk-node-vX.Y.Z` or `sdk-node-vX.Y.Z-pre.N` | `sdk-node-v0.1.0-alpha.0` | [Publish SDK](../.github/workflows/publish-sdk.yml) |

Tags are created by a maintainer on a commit that is already on `main` and green in CI. Use annotated tags.

## What each workflow does

### Release (`release.yml`, tags `v*`)

1. Runs `npm ci`, `npm run check`, and `npm run build` when a build script exists.
2. Fails unless the root `package.json` version equals the tag without its `v`.
3. Extracts the `## [X.Y.Z]` section from `CHANGELOG.md` and fails with a clear message when the section is missing or empty.
4. Fails unless `packages/event-schema/schema/event-envelope.v1.json` parses as JSON and its `$schema` is draft 2020-12.
5. Creates the GitHub Release with that text as the notes. Tags containing a hyphen are marked as pre-releases.
6. Attaches:
   - `event-envelope.v1.json`: the event envelope JSON Schema from `packages/event-schema/schema/`, byte-identical to the tagged commit. The latest stable copy is always at `https://github.com/bigbimbs/jekimo/releases/latest/download/event-envelope.v1.json`.
   - `event-envelope.v1.json.sha256`: its SHA-256 in `sha256sum` format.
   - `jekimo-docs-X.Y.Z.tar.gz`: the `docs/` directory as it was at the tag.
   - `SHA256SUMS`: checksums for all three.

It needs `contents: write`, granted to that job only.

### Images (`images.yml`, tags `v*` and pushes to `main`)

Builds `ghcr.io/bigbimbs/jekimo-api` from `apps/api/Dockerfile` and `ghcr.io/bigbimbs/jekimo-worker` from `apps/worker/Dockerfile` for `linux/amd64` and `linux/arm64` with Docker Buildx and the GitHub Actions cache, and pushes them to GitHub Container Registry.

| Trigger | Image tags |
| --- | --- |
| Push to `main` | `edge`, `sha-<short sha>` |
| `vX.Y.Z` | `X.Y.Z`, `X.Y`, and `latest` when it is the highest stable tag |
| `vX.Y.Z-pre.N` | `X.Y.Z-pre.N` only |

The same rule applies to the GitHub Release: only the highest stable version is marked as the repository's latest release, so a hotfix for an older minor does not replace a newer one.

Every image carries the OCI labels `org.opencontainers.image.source`, `licenses` (`Apache-2.0`), `revision` (the commit), and `version`, plus a provenance attestation and an SBOM. The build context is the repository root so a Dockerfile can copy the workspace packages it needs; the build arguments `JEKIMO_VERSION` and `JEKIMO_REVISION` are passed for Dockerfiles that want to embed them.

An app without a Dockerfile is skipped with a notice, so the workflow is green before the services are packaged. Forks skip the workflow entirely.

It needs `packages: write`, granted to that job only.

### Publish SDK (`publish-sdk.yml`, tags `sdk-node-v*`)

1. Updates npm to 11 (trusted publishing needs npm 11.5.1 or newer).
2. Fails unless `packages/sdk-node/package.json` has the tag's version, is not `"private": true`, and has a `repository` pointing at `https://github.com/bigbimbs/jekimo` (npm verifies provenance against it).
3. Runs `npm ci`, `npm run check`, and `npm run build --workspace packages/sdk-node`, then prints the package contents with `npm pack --dry-run`.
4. Runs `npm publish --provenance --access public`, with dist-tag `next` for pre-releases and `latest` otherwise.

It runs in the `npm` GitHub environment and needs `id-token: write`, granted to that job only.

## One-time setup

These steps are done once, by a maintainer, outside the repository.

### npm

1. Create the `jekimo` organisation on npm (free plan) so the `@jekimo` scope exists: <https://www.npmjs.com/org/create>.
2. npm only accepts a trusted publisher for a package that already exists, so the first SDK version is published with a token:
   1. Create a granular access token on npmjs.com with read and write access to the `@jekimo` organisation's packages, a short expiry, and no IP restriction.
   2. Save it in this repository as the Actions secret **`NPM_TOKEN`** (Settings > Secrets and variables > Actions > New repository secret). It can also be an environment secret of the `npm` environment.
   3. Push the first `sdk-node-v*` tag. The workflow publishes with provenance using the token.
3. Configure trusted publishing: open <https://www.npmjs.com/package/@jekimo/sdk-node/access>, add a Trusted Publisher of type GitHub Actions with organization or user `bigbimbs`, repository `jekimo`, workflow filename `publish-sdk.yml`, and environment name `npm`.
4. Delete the `NPM_TOKEN` secret and revoke the token on npmjs.com. From now on publishing uses OIDC only.
5. Recommended: on the package's access page, require two-factor authentication and disallow tokens for publishing.

### GitHub

- **Environment:** the `npm` environment is created automatically the first time the Publish SDK workflow runs. To require an approval before every publish, add required reviewers under Settings > Environments > `npm`.
- **Container packages:** the first push of each image creates the `jekimo-api` and `jekimo-worker` packages under the `bigbimbs` account. GitHub creates them as **private**. Open each package (Profile > Packages), check that it is linked to the `jekimo` repository, and change its visibility to **public** under Package settings so operators can pull without signing in.
- **Workflow permissions:** no change needed. Each job requests the permissions it uses, which works with the default read-only `GITHUB_TOKEN` setting.

## Release checklist

### Jekimo release

1. Make sure `main` is green in CI and the [Images](../.github/workflows/images.yml) workflow has produced a working `edge` image.
2. On a branch, edit `CHANGELOG.md`:
   - Move the entries under `## [Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD` section directly below it, leaving `## [Unreleased]` empty. The Release workflow takes its notes from this section.
   - Update the link references at the bottom: `[Unreleased]` compares `vX.Y.Z...HEAD`, and add `[X.Y.Z]` for `vPREVIOUS...vX.Y.Z` (or the tag's release page for the first release).
   - Call out breaking changes, contract version changes, required migrations, and any new permissions that roles should be reviewed for ([access-model.md](access-model.md)).
3. Bump the version to `X.Y.Z` in the root `package.json` and in every `apps/*/package.json` and server-side `packages/*/package.json` (everything except `packages/sdk-node`):

   ```bash
   npm version X.Y.Z --no-git-tag-version --workspaces --include-workspace-root
   git checkout packages/sdk-node/package.json   # the SDK is versioned separately
   npm install                                   # refresh package-lock.json
   ```

4. If the release changes what operators do, update [install-vps.md](install-vps.md) (upgrade notes, new variables) and [configuration.md](configuration.md).
5. If supported versions change, update the table in [SECURITY.md](../SECURITY.md).
6. Open a pull request titled `chore(release): vX.Y.Z`, get it reviewed, and merge it.
7. Tag the merge commit and push the tag:

   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m "Jekimo X.Y.Z"
   git push origin vX.Y.Z
   ```

8. Watch the Release and Images workflows. Check that the GitHub Release has the notes and four assets, and that `ghcr.io/bigbimbs/jekimo-api:X.Y.Z` and `ghcr.io/bigbimbs/jekimo-worker:X.Y.Z` exist for both architectures.

### SDK release

1. Add the SDK changes to `CHANGELOG.md` under a `### @jekimo/sdk-node X.Y.Z` heading in the section being released, or under `## [Unreleased]` when the server is not being released at the same time.
2. Bump `packages/sdk-node/package.json` to the new version and run `npm install` to refresh the lockfile. Make sure the SDK's `User-Agent` and `sdk.version` read the same version.
3. Merge through a pull request, then tag and push:

   ```bash
   git switch main && git pull
   git tag -a sdk-node-vX.Y.Z -m "@jekimo/sdk-node X.Y.Z"
   git push origin sdk-node-vX.Y.Z
   ```

4. Check <https://www.npmjs.com/package/@jekimo/sdk-node>: the version is there, under `next` for a pre-release, with a provenance badge.

## When a release goes wrong

### The workflow failed

Nothing was published by a failed step that comes before the publish step. Fix the cause on `main` through a pull request, then move the tag and push it again:

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
git tag -a vX.Y.Z -m "Jekimo X.Y.Z"     # on the fixed commit
git push origin vX.Y.Z
```

Only do this when nothing was published from the tag. Once a GitHub Release, image, or npm version exists, treat the version as used and release a new one.

### Yanking a bad Jekimo release

1. Edit the GitHub Release: mark it as a pre-release and add a warning at the top of the notes that names the problem and the replacement version. Do not delete the release or the tag; operators and links depend on them.
2. If `latest` points at the bad version, release the fix as soon as possible; pushing the fixed tag moves `latest`. Container image tags are not deleted, because deleting them breaks installs that pinned them.
3. If the problem is a security issue, follow [SECURITY.md](../SECURITY.md) and publish an advisory.

### Yanking a bad SDK release

npm versions cannot be reused. Deprecate the version so installs warn, and publish a fix:

```bash
npm deprecate @jekimo/sdk-node@X.Y.Z "Broken: <reason>. Use X.Y.Z+1."
```

`npm unpublish` is only allowed within 72 hours and leaves the version number unusable; prefer deprecation. If `latest` must move back before a fix is ready: `npm dist-tag add @jekimo/sdk-node@<good version> latest`.

### Hotfixes

Fixes land on `main` first and are released as the next patch version. For `0.x`, only the latest minor gets patches. After `1.0.0`, a fix for the previous minor (supported for 90 days, see [SECURITY.md](../SECURITY.md)) is made on a `release/X.Y` branch created from the `vX.Y.Z` tag, with the fix cherry-picked from `main`, and tagged `vX.Y.(Z+1)` from that branch. The changelog entry is added to both branches.
