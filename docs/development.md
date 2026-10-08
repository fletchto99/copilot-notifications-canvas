# Development

[README](../README.md) | [Usage](usage.md) | [Installation](installation.md) | [Settings](settings.md)

Coding agents should follow [AGENTS.md](../AGENTS.md). Copilot also loads
[`.github/copilot-instructions.md`](../.github/copilot-instructions.md), which
points to the shared repository guidance.

## Local development

Development tooling requires Node.js 24 or later (`package.json` declares
`>=24`). The checked-in `.node-version` selects the Node.js 24 development line;
use a current patched release. With nvm, run
`nvm install "$(cat .node-version)"`. The extension runtime and installer still
support Node.js 22 or later; their dependency-free tests retain Node.js 22
coverage.

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

### Synthetic preview

```sh
npm run dev:fixture
```

This standalone preview needs only Node.js, not development dependencies,
GitHub sign-in, or the Copilot host. It shares the browser tests' synthetic
fixture and runs the real renderer and protected loopback server. The sample
inbox includes pagination, search, and multiple attention categories. GitHub
reads, read/done updates, release checks, and desktop delivery are simulated.

Choose a reproducible preset with `--scenario`:

```sh
npm run dev:fixture -- --scenario=stale
npm run dev:fixture -- --help
```

| Scenario | Behavior |
| --- | --- |
| `populated` | Default inbox with 53 notifications, pagination, and multiple attention categories. |
| `empty` | Successful response with no notifications. |
| `long-titles` | Long wrapping and unbroken titles and a long repository name for narrow-panel checks. |
| `rate-limited` | Notification reads return HTTP 429 with a 120-second retry header. Real provider backoff applies, including to Force refresh. |
| `stale` | The first notification read succeeds. Click **Force refresh** to fail the next read with HTTP 503 while retaining the loaded rows. |

`--scenario stale` is also accepted. Unknown names, extra arguments, and duplicate
options fail before starting a server. Restart the command to switch or reset
scenarios; there is no in-page scenario switcher. The error presets continue
failing notification reads after their retry waits, so the provider may increase
backoff. Settings and synthetic release checks remain available. Scenario
definitions in `test/preview-scenarios.mjs` reuse the shared request hooks rather
than forcing renderer state.

Open the printed `file://` launcher in a browser. It redirects to the preview
without printing its capability URL to terminal logs. The launcher is stored
with owner-only permissions in a private temporary directory; do not share it
or the resulting browser URL. The footer identifies the preview and selected scenario.
GitHub links in the renderer still navigate to GitHub when explicitly clicked.

Settings and desktop coordination files stay in that temporary directory, never
in your real `COPILOT_HOME`. Desktop alerts start off; enabling them only records
simulated deliveries in memory. Ctrl+C or SIGTERM stops the server and removes
the launcher and temporary settings. Each run starts fresh. After source or
asset changes, stop and restart the preview; it does not hot-reload. This does
not validate host SDK integration or host-provided theme tokens.

### Environment check

Select Node.js 24 using the repository's `.node-version` and your version
manager, then run:

```sh
npm run doctor
```

The read-only check reports the supported Node version, installed development
dependency versions, `actionlint` availability, and Chromium/WebKit executable
paths. It exits nonzero if a prerequisite is missing or cannot be inspected and
prints remediation commands. It does not install tools, launch browsers,
authenticate with GitHub, inspect notification data, or change preferences.
It runs even before development dependencies are installed.

Use `npm ci --ignore-scripts --engine-strict` to restore development dependencies. For
`actionlint`, macOS users can run `brew install actionlint`; with Go installed,
run `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12` and add Go's
binary directory to `PATH`. Linux users can also follow the checksum-verified
installation steps in the [setup workflow](../.github/workflows/copilot-setup-steps.yml).
Browser installation is described below. Finding browser executables does not
prove that Linux system libraries or headless launch dependencies are available;
the browser tests provide that validation.

## Tests and checks

Unit and HTTP integration tests need no dependency installation:

```sh
node --test test/*.test.mjs
```

For lint, coverage, packaging, and browser checks:

```sh
npm ci --ignore-scripts --engine-strict
npm run lint
npm run lint:workflows  # Requires actionlint on PATH.
npm run test:coverage
npm run build
npm run test:package
npx playwright install --with-deps chromium webkit
npm run test:browser
```

`npm run lint` runs all source checks:

- `npm run lint:js` checks JavaScript with ESLint.
- `npm run lint:css` checks CSS with Stylelint and `stylelint-config-standard`.
- `npm run format:css:check` checks CSS formatting with Prettier.
- `npm run lint:recovery` checks the embedded recovery JavaScript and CSS with
  the same browser ESLint rules and Stylelint configuration.

CI runs each check as a separate step. Stylelint catches CSS errors and enforces
CSS conventions; Prettier keeps the stylesheet readable with multiline rules
and declarations.

Lint, Windows and browser checks, cloud setup, and release tooling read
`.node-version` to use current Node.js 24. The runtime test matrix explicitly
covers Node.js 22 and 24, with source coverage on Node.js 22. Every CI dependency
install uses `--engine-strict` so unsupported package engines fail instead of
only warning. Release bundles still target Node.js 22; the development
requirement does not raise the runtime minimum. CI does not separately test the
initial 24.0.0 release.

The recovery lint check starts an isolated loopback server with synthetic
missing renderer assets and lints the fallback content it serves. It makes no
GitHub requests, sends no desktop alerts, and checks invalid snippets to verify
that the lint rules reject errors. Its tooling-only integration tests require
development dependencies and stay outside the dependency-free Node test suite.
The fallback remains embedded in the provider; no development build or runtime
recovery-file reads are introduced.

The Stylelint configuration retains prefix-style media queries and allows
shared state and component rules to rely on specificity rather than source
order. Inline exceptions preserve the existing WebKit select and screen-reader
clipping fallbacks; unused exceptions fail lint.

Run `npm run format:css` to format `src/**/*.css`, or
`npm run format:css:check` to check formatting without writing files. These
formatting commands do not touch JavaScript or other files. For autofixable
Stylelint findings, run `npm run lint:css -- --fix` before `npm run format:css`.
Keep source styles in plain CSS; release builds minify the stylesheet
automatically.

Coverage also works without `npm ci`. It enforces aggregate minimums of 95% for
lines, branches, and functions, not per-file minimums. Every eligible runtime
and release/installer module must appear in the report. The coverage reporter
and build script remain excluded from the percentages; packaged integration
tests validate the build separately.

Playwright downloads browser binaries and may need permission to install Linux
system libraries. Use `-- --project=webkit` with `npm run test:browser` to run one
engine.

For an explicit full local check after targeted tests, run:

```sh
npm run check:full
```

This runs the environment check, JavaScript/workflow lint, all Node tests with
coverage, the release build, packaged integration tests, and browser/accessibility
tests in both Chromium and WebKit, stopping at the first failure. It never
installs missing prerequisites, skips unavailable checks, or publishes a release.
Build output and test reports remain in their ignored directories.

CI separates source linting (`Lint`, on `ubuntu-slim`) from workflow linting
(`Actionlint`, on `ubuntu-latest`). Workflow lint uses the repository-owned
[Docker action](../.github/actions/actionlint/action.yml). Its
[Dockerfile](../.github/actions/actionlint/Dockerfile) contains only the
[official actionlint Docker image](https://github.com/rhysd/actionlint/blob/main/docs/usage.md#docker),
pinned by version and digest, including its ShellCheck and Pyflakes integrations.
The action always passes `-color -verbose`, listing checked workflows and the
final error count even on successful runs. It needs no Node setup or npm
installation. The Docker action needs a full Linux
VM: [`ubuntu-slim`](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#single-cpu-runners)
is an unprivileged container and does not support Docker-in-Docker.
Docker-based jobs and Copilot setup use `ubuntu-latest`; lightweight Linux tests,
source lint, and release jobs use `ubuntu-slim`. The container digests pin the
tool environments independently of the host Ubuntu release.

The weekly `docker` entry in [Dependabot configuration](../.github/dependabot.yml)
tracks the Dockerfile actually used by CI. It takes effect on the default branch;
the `github-actions` updater does not track inline `docker://` references.
Dependabot can propose image tag and digest updates, but it does not update the
binary URL/checksum in Copilot setup or the installation guidance. For version
bumps, update those companion pins, the doctor remediation command, and the
versioned Go installation command above. A dedicated alignment test rejects
version drift. Digest-only changes for the same version retain that alignment.
Always verify new image digests and binary checksums before accepting an update.

Copilot setup still installs that binary so agents can run `npm run lint:workflows`
in their own session; the CI container does not provision the agent environment.
If CI check names change, repository administrators must coordinate corresponding
required-check rules separately; editing a workflow does not update those rules.

See the [test workflow](../.github/workflows/tests.yml) for platform coverage and
required checks. Browser CI runs both engines in the official Playwright image,
which includes browser binaries and system libraries; it does not run APT or
download browsers during each job. The image is pinned by version and digest.
Update both pins whenever the locked `@playwright/test` version changes; the
workflow tests check that the versions match. PR/main CI validates packaging
but never publishes releases.
Tests use synthetic GitHub responses and isolated settings: no sign-in, live
read updates, or OS notifications. SDK stubs do not verify compatibility with a
specific Copilot build; reload and inspect the real extension after SDK changes.

## Copilot cloud agent and code review

[Copilot setup steps](../.github/workflows/copilot-setup-steps.yml) prepare an
full Ubuntu runner (`ubuntu-latest`) with Node.js 24, locked development dependencies,
and checksum-verified `actionlint`. Cloud-agent sessions and code reviews share
this lightweight setup, without a separate review workflow. It checks tool
availability without running the test suite, installing the extension, or
publishing a release. It needs no notification credentials or separately
installed Copilot SDK.

Setup does not install browser binaries or system libraries. For tasks needing
browser validation, run the Playwright installation command in
[Tests and checks](#tests-and-checks) on demand. Downloads need network access,
and Linux system libraries may require installation permission; report any
environment restrictions rather than treating unrun tests as passing. Browser
and accessibility validation still runs in CI's pre-provisioned container.

Copilot uses the shared setup once the workflow is on the default branch. It
does not configure local Copilot app/CLI sessions. Manual runs and path-filtered
pull-request/main runs validate setup when the workflow, `.node-version`, or
dependency manifests change; the agent still runs the checks relevant to its task.

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
