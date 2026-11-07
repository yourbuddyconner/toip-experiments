# Releasing

The eight libraries in `packages/` are published to npm as `@toip-tools/<name>`. They share one version: Changesets releases them as a fixed group. The projects in `projects/` and the site are private. Changesets never versions or publishes them.

Versions, changelogs and publishing are done by [Changesets](https://changesets.dev) and the Release workflow (`.github/workflows/release.yml`).

## Day to day

1. Change a library. Then run `npm run changeset`. Pick the packages you changed and the bump (patch, minor or major). Write one or two sentences for the changelog. Commit the new file in `.changeset/` with your change.
2. When the change reaches `main`, the Release workflow opens a pull request named "Version Packages", or updates the open one. It sets the new version, writes each `CHANGELOG.md` and updates `package-lock.json`.
3. Merge the "Version Packages" pull request. The Release workflow builds the libraries, checks the tarballs, and publishes them to npm with provenance. Then it pushes a git tag and a GitHub release for each package.

A change that needs no release (tests, docs, the projects) needs no changeset.

GitHub does not start CI on a pull request that a workflow opened. To run CI on "Version Packages", close it and reopen it.

To check the tarballs locally without publishing:

```sh
npm run release:check
```

## Settings to make once

- In the repository settings, under Actions, General, turn on "Allow GitHub Actions to create and approve pull requests".
- The publish job runs in a GitHub environment named `npm`. GitHub creates it on the first run. To approve each publish by hand, add required reviewers to it.

## The first release

npm can only set up trusted publishing for a package that already exists. So publish 0.1.0 once from your own machine. Do this before the merge of this setup reaches `main` on GitHub. Otherwise the Release workflow tries to publish first, and that run fails, because nothing lets it publish yet.

1. Sign in to npm with an account that can publish to the `@toip-tools` organization:

   ```sh
   npm login
   ```

2. From a clean checkout of `main` with this setup merged:

   ```sh
   npm ci
   npm run release:check
   npm run release
   ```

   `npm run release` builds the libraries, publishes the eight packages at 0.1.0, and creates a git tag for each one. A publish from your machine has no provenance. Every later publish from CI has it.

3. Push `main` and the tags:

   ```sh
   git push origin main --tags
   ```

4. Set up trusted publishing on npmjs.com for each of the eight packages: `@toip-tools/trust-core`, `@toip-tools/relay`, `@toip-tools/cose`, `@toip-tools/web-vault`, `@toip-tools/mandates`, `@toip-tools/anon-membership`, `@toip-tools/eventlog` and `@toip-tools/mesh-transport`. On each package page, open Settings, then Trusted Publisher, choose GitHub Actions, and enter:

   - Organization or user: `yourbuddyconner`
   - Repository: `toip-tools`
   - Workflow filename: `release.yml`
   - Environment name: `npm`

   Then, under Publishing access, you can require two-factor authentication and disallow tokens.

From then on, releases go through the "Version Packages" pull request.

Another way to do the first release: create an npm access token that can publish to `@toip-tools`, and add it to the repository as the secret `NPM_TOKEN`. Then merge this setup, and the Release workflow publishes 0.1.0 itself, with provenance. Set up trusted publishing afterwards, and delete the secret.

## Prereleases

To publish versions like `0.2.0-next.0` under the npm tag `next`:

```sh
npx changeset pre enter next
```

Commit `.changeset/pre.json`. Changesets added while it is there make prerelease versions, and the "Version Packages" pull request publishes them under `next`. `npm install @toip-tools/<name>` still gets the latest stable version; `npm install @toip-tools/<name>@next` gets the prerelease.

To finish, run `npx changeset pre exit` and commit. The next "Version Packages" pull request makes the stable version.

## If the repository moves

The packages point at `github.com/yourbuddyconner/toip-tools`. If the repository is renamed or moved, update `repository` and `bugs` in each `packages/*/package.json`, and update the trusted publisher on npmjs.com for each package. Publishing from the release workflow fails until the trusted publisher matches the new name.
