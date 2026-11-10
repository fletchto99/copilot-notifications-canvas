# Development

[README](../README.md) | [Usage](usage.md) | [Copilot](copilot.md) | [Installation](installation.md) | [Settings](settings.md)

**Jump to:** [Preview](#synthetic-preview) | [Screenshot](#readme-screenshot) |
[Environment check](#environment-check) | [Tests](#tests-and-checks) |
[Packaging](#packaging) | [Releases](#publishing-releases)

[AGENTS.md](../AGENTS.md) is the shared source for architecture, implementation
conventions, privacy, and lifecycle invariants.

## Local development

Use a current patched **Node.js 24+** for development; `.node-version` selects
the preferred major. The extension runtime and installer still support Node.js
22, which remains covered by the dependency-free tests.

Edit provider modules and renderer assets in `src/`. The discovery shim at
`.github/extensions/github-notifications/extension.mjs` imports
`src/extension.mjs`: opening this repository as a Copilot project loads source
without a build. After edits or branch changes, reload extensions and use
extension **list/inspect** to check the provider and its log.

The source footer shows `dev (v<version>) <branch-name>` (`detached HEAD` or
`branch unavailable` when applicable); packaged releases omit it. If both local
and installed providers appear, select `extensionId: project:github-notifications`.
Sessions keep their loaded code and assets until reloaded; never delete a
checkout still in use. See [Settings](settings.md) for auto-open and dismissal.

### Selecting a development API

In a source-loaded canvas, open **Settings > Development API**, choose
**Custom**, enter an HTTPS REST base URL such as `https://git.example.com/api/v3`,
then **Save API** and reload extensions. Choose **GitHub.com** and save/reload to
switch back. The reload shortcut follows the renderer's platform: **Ctrl+K** on
Windows/Linux, **Command+K** on macOS.

The user-wide `developmentApiBaseUrl` preference lives in `artifacts/settings.json`.
It takes effect only at provider startup; loaded rows, batches, retries, and
caches never switch targets mid-session. Settings identifies the active API and
pending reload. Correct invalid values without deleting other settings.
Packaged releases ignore this preference and reject API-selection requests.

Authenticate with GitHub CLI for the **selected host**, for example
`gh auth login --hostname git.example.com`, using that server's supported
credentials and any required private-network connection. The provider uses
`gh api --hostname <host>` and the selected REST URL; it never copies credentials
between hosts. Never put tokens or cookies in URLs, the renderer, or logs.

Supported bases use DNS names or IPv4, optionally with a non-default HTTPS port;
`gh --hostname` receives only the hostname. IPv6 literals, credentials, query
strings, fragments, and encoded paths are rejected. Pagination stays on the
selected notifications endpoint with its original filters and page size.
Destination links use the API's website origin; separate website hostnames are
unsupported. Release discovery and installation remain on GitHub.com.

**Custom APIs may share production data.** Panel read/done actions still write
to GitHub. A banner identifies the custom target; desktop polling and delivery
are disabled without changing saved desktop preferences. Use synthetic fixtures
for automation, never live notification writes.

### Inbox API contract

All (the default) uses `all=true&is_done=false`; Unread only, agent
`mode: "unread"`, and desktop polling use `all=false` without `is_done`.
Both views use `per_page=50`, explicit pagination, and separate caches.
Unfiltered `all=true` is rejected so Done items stay hidden.

**Do not publish the All view before server support for `is_done` is deployed.**
Older servers may silently ignore it. Validate with read-only requests and
aggregate counts against an explicitly selected development API, never captured
notification content.

### Synthetic preview

```sh
npm run dev:fixture
npm run dev:fixture -- --scenario=stale
npm run dev:fixture -- --help
```

The preview runs the real renderer and protected loopback server using
`test/canvas-fixtures.mjs`. It needs only Node.js, not development dependencies,
GitHub sign-in, or Copilot. Reads, read/done writes, release checks, and alerts
are simulated.

| Scenario | Behavior |
| --- | --- |
| `populated` | Default inbox with 53 notifications, pagination, and multiple attention categories. |
| `empty` | Successful response with no notifications. |
| `long-titles` | Long wrapping and unbroken titles and a long repository name for narrow-panel checks. |
| `rate-limited` | Notification reads return HTTP 429 with a 120-second retry header. Real provider backoff applies, including to Force refresh. |
| `stale` | The first notification read succeeds. Click **Force refresh** to fail the next read with HTTP 503 while retaining the loaded rows. |

Presets live in `test/preview-scenarios.mjs`; `--scenario stale` also works.
Invalid or duplicate options fail before startup. Restart to change/reset a
scenario or load source edits; there is no hot reload. Error presets keep failing
notification reads after retry waits, so backoff may increase; Settings remains usable.

Open the printed private `file://` launcher. **Never share it or the resulting
capability URL.** The footer identifies the scenario; explicitly clicked GitHub
links still open GitHub. Settings, the owner-only launcher, and desktop
coordination stay in a temporary directory, never your real `COPILOT_HOME`.
Alerts start off; enabling them records simulated deliveries only. Ctrl+C or
SIGTERM stops the server and removes temporary files.
This does not validate the host SDK or host-provided theme tokens.

### README screenshot

```sh
npm run screenshot:readme
```

Overwrites `docs/images/github-notifications.png` using the real renderer and
`test/readme-fixture.mjs`: ten notifications, seven unread, across `example/atlas`,
`example/design-system`, and `example/cli`, including varied issue/PR/discussion
states and a failed check run. Keep this canonical scene rather than inventing
rows for each PR. **Settings stays closed.** Inspect the image and keep its README
alt text accurate.

Requires [development dependencies](#environment-check) and managed Chromium:
`npx playwright install chromium` (add `--with-deps` on Linux if system libraries
are missing). No GitHub sign-in or Copilot host is needed.

| Fixed capture settings | Value |
| --- | --- |
| Clock / locale / time zone | `2026-01-10T12:00:00Z` / `en-US` / UTC |
| View | All inbox, repository grouping, dark theme |
| Viewport / scale | 735 x 1000 CSS pixels / 2x; full-page PNG, currently 1470 x 2000 |

Capture waits for rows, resolved icons, and fonts; disables animations/carets;
parks the pointer outside content; and omits the development footer.
**Identical pixels require the same locked browser, OS/architecture, and system
fonts.** The renderer's normal font stack is preserved. For a shared Linux
environment, use the exact digest-pinned image in [browser CI](../.github/workflows/tests.yml);
do not expect cross-platform byte equality.

Use `-- --output=readme-preview.png` to keep the README image unchanged (the parent
directory must exist), or `-- --help` for dependency-free usage. The
[regression test](../test/browser/readme-screenshot.spec.mjs) compares fresh captures
within each engine; see [Tests and checks](#tests-and-checks).

The shared synthetic fixture keeps real preferences and alerts untouched.
External browser requests are blocked; notification links and read/done controls
are never clicked. The command saves only after capture, assertions, and cleanup
succeed, and reports failures without exposing capability URLs.

### Environment check

```sh
npm run doctor
```

A read-only check for Node, locked dependencies, `actionlint`, and browser
executables. It works before dependency installation, prints remediation commands,
and fails for missing/uninspectable prerequisites. It does not install tools,
launch browsers, authenticate, read notifications, or change preferences.
Executable checks do not prove browser launch readiness; run browser tests.

| Missing tool | Setup |
| --- | --- |
| Development dependencies | `npm ci --ignore-scripts --engine-strict` |
| Chromium / WebKit | `npx playwright install --with-deps chromium webkit` (system libraries may require permission) |
| actionlint | `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12`, then add Go's binary directory to `PATH`; macOS also supports `brew install actionlint` |

Linux can instead use the checksum-verified actionlint installation in
[Copilot setup](../.github/workflows/copilot-setup-steps.yml).

## Tests and checks

Run from the repository root, starting with tests relevant to the change.
Node tests and coverage need no dependency installation; other checks need the
[tools above](#environment-check).

| Check | Command |
| --- | --- |
| Node unit / HTTP integration | `npm test` |
| Targeted Node tests (example) | `node --test test/server.test.mjs test/inbox.test.mjs` |
| Source coverage | `npm run test:coverage` |
| JS, CSS, formatting, recovery lint | `npm run lint` |
| Workflow lint | `npm run lint:workflows` |
| Release build and packaged integration | `npm run build && npm run test:package` |
| Browser / accessibility, both engines | `npm run test:browser` |
| WebKit only | `npm run test:browser -- --project=webkit` |
| Screenshot reproducibility | `npm run test:browser -- readme-screenshot` |
| Full local validation | `npm run check:full` |

Coverage enforces aggregate **95% lines, branches, and functions**, with every
eligible runtime/release/installer module included. The reporter and build script
are excluded; packaged checks validate the build separately.

`check:full` runs doctor, lint, workflow lint, coverage, build, package tests, and
both browser engines, stopping on failure. It never installs prerequisites,
skips unavailable checks, or publishes. Outputs stay in ignored directories.
Tests use synthetic responses and temporary settings: no sign-in, live writes,
or OS alerts. SDK stubs cannot prove host compatibility; reload and inspect the
real extension after SDK changes.

### Native notification coverage

| Platform | Non-delivering check |
| --- | --- |
| Windows | Construct real PowerShell XML/WinRT payloads with delivery removed; validate click targets, permission/sender failures, cancellation, and at-most-once behavior. XML round-trip tests allow 30 seconds; production keeps its 10-second timeout. |
| macOS | Compile/decompile AppleScript with `osacompile` / `osadecompile`, never execute `display notification`. |
| Linux | Run `notify-send` against an exclusively owned fake service on a private `dbus-run-session`; check escaping, Unicode, and sound hints. |

For Linux, install `dbus-daemon`, `libnotify-bin`, `python3-dbus`, and `python3-gi`,
then run `npm run test:notifications:linux`. It creates and removes its own bus,
never uses the user's notification service, and fails rather than skips when
tools are missing. It is separate from the dependency-free suite.

Visible banners, real OS permissions, Focus/Do Not Disturb, and browser activation
still need manual testing. Windows click targets are checked in the payload;
Linux/macOS click navigation is not implemented.

### Coverage badge

The badge reports measured Node.js 22 **line coverage**, rounded to two decimals,
not the minimum threshold. `COVERAGE_BADGE_PATH` makes the reporter write an SVG;
ordinary local runs do not. CI uploads only that SVG, not source/per-file data.

After a successful main push, the separate **Coverage badge** workflow publishes
the exact run's SVG to the independent `badges` branch. Only the publisher has
`contents: write`; it never executes repository code or force-pushes. It checks
`main` before preparing and pushing the update, skipping superseded commits
(these checks are not atomic with changes to `main`).

PRs, tags, failed runs, and manual runs cannot publish. Before the first successful
main push the image is absent; later failures leave the last badge in place.
Use the adjacent CI badge for current build health. No external service, extra
secret, or source-branch commit is needed. Repository rules must allow Actions
to create/update `badges`; publication failures remain visible in the workflow.

### Tooling and browser coverage

`npm run lint` combines `lint:js` (ESLint), `lint:css` (Stylelint),
`format:css:check` (Prettier), and `lint:recovery`. Recovery lint checks the actual
embedded fallback served by an isolated loopback server, including invalid
snippets; its dependency-requiring integration tests stay outside the Node suite.

Keep styles in plain CSS. Use `npm run lint:css -- --fix` for autofixable findings,
then `npm run format:css`; `format:css:check` is read-only. Formatting touches
only CSS; release builds minify it. Preserve the Stylelint exceptions for WebKit
selects and screen-reader clipping; unused exceptions fail lint.

The [test workflow](../.github/workflows/tests.yml) defines platform coverage:
Node.js 22/24 runtime tests, with coverage on 22; `.node-version` for tooling;
strict engine checks on every dependency install; and Node.js 22 release bundles.
It does not separately test the initial Node.js 24.0.0 release.

**Workflow lint:** the [Docker action](../ci/actionlint/action.yml) uses a
version/digest-pinned [upstream image](../ci/actionlint/Dockerfile), preserving
ShellCheck, Pyflakes, and `-color -verbose` output. Docker jobs, Linux native tests,
and Copilot setup use `ubuntu-latest`; Node.js 22 coverage, source lint, and release
jobs use `ubuntu-slim`, which cannot run Docker-in-Docker.

[Dependabot](../.github/dependabot.yml) tracks `ci/actionlint/Dockerfile` weekly
on the default branch, not inline `docker://` references. For version bumps,
verify the image digest and setup binary checksum, then align Copilot setup's
URL/checksum, doctor remediation, and the Go install command above.
The alignment test enforces this; digest-only updates need no version changes.
The CI image does not provision agent tools. Administrators must update
required-check rules separately if workflow check names change.

**Browser CI:** both engines run in a version/digest-pinned Playwright image
with browsers and libraries preinstalled. Update its version and verified digest
with the locked `@playwright/test` dependency; alignment is tested.
Each engine runs in four parallel shards, for eight browser jobs total, with two
Playwright workers per job. With `fullyParallel` enabled, Playwright distributes
individual tests across shards by count, not duration; new tests are included
automatically without category lists. Every shard validates packaging and uploads
its own HTML report and failure traces as `browser-results-<browser>-<shard>`.
Failures do not cancel the other shards.

Each shard has a 15-minute limit for container startup, packaging, tests, and
report uploads; Playwright's per-test timeout remains 30 seconds.
After `npm run build`, reproduce a shard locally with
`npm run test:browser -- --project=chromium --shard=1/4 --workers=2`, substituting
the browser and shard number. Omit `--shard` to run the full selected suite.
Use **Browser tests** as the required browser check in branch protection or
rulesets, replacing any requirements for individual browser/shard jobs.
This lightweight aggregate job depends on the entire browser matrix and passes
only when every shard succeeds; failed, cancelled, or skipped browser jobs cannot
produce a green aggregate check. Its name stays unchanged when the shard count
changes. Individual shard jobs and reports remain available for diagnosis.
Keep any required Node and lint checks separately; this check covers browsers only.
PR/main CI validates packaging but never publishes releases.

Copilot discovery browser tests advance a test-only provider clock instead of
waiting real minutes. Source fixtures inject `CopilotHost.now`; packaged fixtures
control `Date.now` inside their isolated child process and acknowledge clock changes
over IPC. Clock updates wait for pending discovery to settle and its provider-side
completion handlers to finish; parent-side callback counts alone do not prove
the next retry deadline has been scheduled. Renderer polling and provider timers
still run normally. These tests
keep the default per-test timeout and check late recovery plus the 179,999/180,000 ms
boundary; unit tests cover every retry deadline. Production timing is unchanged.

Browser race regressions use held synthetic responses to control request order,
not sleeps or retries. Settings reads must not take focus from pending row
actions. Theme checks wait for temporarily disabled controls and open
customizable pickers before inspecting their options; WebKit can retain stale
computed styles for options in a closed picker. Intentionally disabled or hidden
customizable pickers are not inspectable until enabled or shown.
Long palette checks pause periodic polling while inspecting picker styles,
then resume the clock for Axe analysis, which needs timers. Separate tests
exercise background Settings polling and focus restoration.
Opening Settings also waits for its native `toggle` event and settings load:
the panel can be visible before that deferred event disables its controls.
Hidden-polling checks observe local requests after the visibility callback and
advance controlled clocks past a due refresh. Layout probes stay installed
through animation frames. DOM-identity checks wait for the renderer to acknowledge
the specific snapshot version; receiving HTTP headers alone does not prove that
the response was consumed or rendered.
View-persistence tests wait for the selected view's status-selection version in
a completed state response before reloading. Row counts can update before that
follow-up fetch; navigating then can produce WebKit access-control errors.
Compare related computed styles in one retried DOM snapshot, requiring nonempty
values. A one-time style read during regrouping can capture an empty value that
no amount of retrying the other element will satisfy.

Windows lock tests preserve existing files and directory links before publishing
candidate directories: a failed directory rename is not a safe guard on Windows.

## Copilot cloud agent and code review

[Copilot setup](../.github/workflows/copilot-setup-steps.yml) supplies an
`ubuntu-latest` runner with Node.js 24, locked dependencies, and checksum-verified
actionlint for cloud-agent sessions and code reviews. It checks availability,
not tests, extension installation, or releases; no notification credentials or
separate SDK are needed.

Once on the default branch, setup applies to cloud sessions, **not local app/CLI
sessions**. It omits browsers and system libraries: install them
[on demand](#environment-check), then run the relevant checks. Report network
or permission restrictions rather than treating unrun checks as passing.
Manual and path-filtered PR/main runs validate setup changes.

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
