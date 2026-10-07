# Development

[README](../README.md) | [Installation](installation.md) | [Settings](settings.md)

Coding agents should follow [AGENTS.md](../AGENTS.md). Copilot also loads
[`.github/copilot-instructions.md`](../.github/copilot-instructions.md), which
points to the shared repository guidance.

## Local development

Provider modules and renderer assets live in `src/`. The entry point at
`.github/extensions/github-notifications/extension.mjs` imports
`src/extension.mjs`, so opening this repository as a Copilot project loads the
local source without a build. After edits, reload extensions and use extension
**list/inspect** to check the provider and its log.

Source checkouts show `dev (v<version>) <branch-name>` in the footer, using
`version.json` and the extension checkout's branch when the panel opens. Reload
extensions after switching branches. Detached checkouts show `detached HEAD`;
if Git is unavailable, the footer shows `branch unavailable` and the provider
logs a warning. Packaged releases do not show this development label.

Each session uses its own checkout and loaded asset snapshot; do not delete a
checkout while a session uses it. A project-local checkout shadows a user-wide
installation. If both providers are registered, pass
`extensionId: project:github-notifications` when opening the local canvas.

## Tests and checks

Unit and HTTP integration tests need no dependency installation:

```sh
node --test test/*.test.mjs
```

For lint, coverage, packaging, and browser checks:

```sh
npm ci --ignore-scripts
npm run lint
npm run lint:workflows  # Requires actionlint on PATH.
npm run test:coverage
npm run build
npm run test:package
npx playwright install --with-deps chromium webkit
npm run test:browser
```

Coverage also works without `npm ci`. It enforces aggregate minimums of 95% for
lines, branches, and functions, not per-file minimums. Every eligible runtime
and release/installer module must appear in the report. The coverage reporter
and build script remain excluded from the percentages; packaged integration
tests validate the build separately.

Playwright downloads browser binaries and may need permission to install Linux
system libraries. Use `-- --project=webkit` with `npm run test:browser` to run one
engine.

See the [test workflow](../.github/workflows/tests.yml) for platform coverage and
required checks. PR/main CI validates packaging but never publishes releases.
Tests use synthetic GitHub responses and isolated settings: no sign-in, live
read updates, or OS notifications. SDK stubs do not verify compatibility with a
specific Copilot build; reload and inspect the real extension after SDK changes.

## Copilot cloud agent

[Copilot setup steps](../.github/workflows/copilot-setup-steps.yml) prepare an
Ubuntu 24.04 environment with Node.js 22, locked development dependencies,
Chromium and WebKit with their system libraries, and checksum-verified
`actionlint`. The workflow checks tool availability without running the test
suite, installing the extension, or publishing a release. It needs no
notification credentials or separately installed Copilot SDK.

Copilot uses these steps once the workflow is on the default branch. They do
not configure local Copilot app/CLI sessions. Manual runs and path-filtered
pull-request/main runs validate setup when the workflow or dependency manifests
change; the agent still runs the checks relevant to its task.

## Packaging

Release builds start from `src/extension.mjs`, not the development entry point.
The build defaults to the repository-root `version.json`; an explicit tag must
match it. Output goes in ignored `dist/`; archives are reproducible with the same
source and toolchain. Local builds are for validation, not distribution, and are
not attested release packages.

The installed `extension.mjs` bundles provider code, renderer assets, version,
and ownership metadata. Development dependencies are excluded; the Copilot SDK
is host-provided. Upgrades replace the bundle atomically and leave `artifacts/`
in place. Existing sessions keep their loaded code and assets until reloaded.

## Publishing releases

1. Bump the repository-root `version.json` in a release PR, using a stable
   semantic version (`vMAJOR.MINOR.PATCH` for the tag). This file is the release
   version's source of truth; `package.json` only describes development tooling.
2. Merge into protected `main`, then tag that exact commit and push the tag.
   From an up-to-date checkout of the intended release commit, for example:

   ```sh
   git tag -a v0.2.0 -m "Release v0.2.0"
   git push origin v0.2.0
   ```

3. Monitor the [release workflow](../.github/workflows/release.yml). It runs all
   PR checks, builds and attests the archive, enforces the
   [installation verification policy](installation.md#manual-installation-and-updates),
   then publishes and verifies an immutable release as **Latest**.
4. Review the generated release notes for behavior changes and update guidance.

Only `v*` tag pushes publish releases; PR/main checks do not. The workflow
never creates or moves tags, bumps versions, or commits build output.

### Repository requirements

- Enable **release immutability**; it applies to future releases, not older ones.
- Restrict `v*` tag creation to the release maintainer and block updates and
  deletion without bypasses.
- Keep `main` protected. Configure these repository settings again for a fork;
  the workflow does not configure them.

Provenance signing shares the build job; this is not an isolated trusted builder
or SLSA Build Level 3.

### Failed or incorrect releases

- Retry failures before draft creation. If an upload/publication failure leaves
  a draft, inspect it first; remove only that incomplete draft, not its tag,
  before rerunning the job.
- Never overwrite published assets, move published tags, or reuse versions.
  Fix a bad release by publishing a higher version.
