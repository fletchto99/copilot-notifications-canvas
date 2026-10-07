# Development

[README](../README.md) | [Installation](Installation.md) | [Settings](Settings.md)

## Local development

Provider modules and renderer assets live in `src/`. The entry point at
`.github/extensions/github-notifications/extension.mjs` imports
`src/extension.mjs`, so opening this repository as a Copilot project loads the
local source without a build. After edits, reload extensions and use extension
**list/inspect** to check the provider and its log.

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

Coverage also works without `npm ci`. Playwright downloads browser binaries and
may need permission to install Linux system libraries. Use `-- --project=webkit`
with `npm run test:browser` to run one engine.

See the [test workflow](../.github/workflows/tests.yml) for platform coverage and
required checks. PR/main CI validates packaging but never publishes releases.
Tests use synthetic GitHub responses and isolated settings: no sign-in, live
read updates, or OS notifications. SDK stubs do not verify compatibility with a
specific Copilot build; reload and inspect the real extension after SDK changes.

## Packaging

Release builds start from `src/extension.mjs`, not the development entry point.
The build defaults to the repository-root `version.json`; an explicit tag must
match it. Output goes in ignored `dist/`. Archives are reproducible with the same
source and toolchain. Local builds are for validation, not distribution.

The installed runtime is one self-contained `extension.mjs` beside `artifacts/`.
It bundles HTML, minified browser JavaScript and CSS, provider code, version,
and ownership metadata. Development dependencies are not included; the Copilot
SDK remains host-provided.

Upgrades stage and verify the replacement, then activate it with one atomic
file rename. There is no separate installed manifest or accumulating runtime
directory. An error before activation leaves the previous bundle intact; an
interruption after activation leaves a complete new bundle. A retry recognizes
whichever version is installed. Already-running providers retain their loaded
code and embedded assets, even when opening another panel, until reloaded.

## Publishing releases

Use stable semantic versions (`vMAJOR.MINOR.PATCH`). Bump the repository-root
`version.json` in the release PR; it is the release version's single source of
truth. `package.json` only describes development tooling.

After merging the version change into protected `main`, tag that exact commit
and push the tag. From an up-to-date checkout of the intended release commit:

```sh
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

Only `v*` tag pushes trigger the [release workflow](../.github/workflows/release.yml).
It validates the version and `main` ancestry, runs all PR checks, then builds,
tests, and attests the exact archive with SHA-pinned `actions/attest`.

The build job has `contents: read`, `attestations: write`, and `id-token: write`.
The separate publisher gets `contents: write` and `attestations: read`. It
downloads the exact Actions artifact by ID, rejects digest mismatches, and never
installs build dependencies or executes the package.

Before publishing, it rechecks the tag's tested commit and `main` ancestry,
rejects existing releases or drafts, and enforces the
[installation provenance policy](Installation.md#manual-installation-and-updates).
`SHA256SUMS` must match the attested archive's digest and filename. Missing or
failed verification stops publication. The workflow never creates or moves tags,
bumps versions, or commits build output.

Publishing is serialized. GitHub CLI creates a draft, uploads the archive and
`SHA256SUMS`, then publishes that exact release by ID as **Latest**. The job
verifies the immutable release and both assets before reporting success.
Review the generated release notes for behavior changes and update guidance.

### Repository requirements

Keep **release immutability enabled**. The `v*` tag rules must allow creation
only by the release maintainer and block updates and deletion without bypasses.
Existing branch protections remain in place. These settings are separate from
the workflow and must be configured again for a fork. Immutability affects
future releases, not older mutable releases.

Provenance signing shares the build job; this is not an isolated trusted builder
or SLSA Build Level 3. Real signing requires a release-tag run; local builds are
not attested release packages.

### Failed or incorrect releases

An existing release or asset is never overwritten. A failure before draft
creation can be retried. If an upload/publication failure leaves a draft,
inspect it first; remove only that incomplete draft (not its tag) before
rerunning the job. Never replace assets on an already-published release.

Publish increasing versions; never move a published tag or reuse a version.
For a bad release, publish a fixed version rather than modifying existing
release code. Keep release-tag creation limited to authorized maintainers.
