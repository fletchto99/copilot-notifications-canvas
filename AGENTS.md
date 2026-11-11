# Repository guidance for agents

These instructions apply to the whole repository. Keep shared guidance here;
`.github/copilot-instructions.md` is the Copilot entry point. Read the relevant
implementation and tests before changing behavior. The [README](README.md) and
[guides](README.md#documentation) document the user-facing contract,
installation safeguards, and release process.

## Project and source layout

GitHub Notifications is a GitHub Copilot canvas extension for **github.com**.
Its runtime supports Node.js 22 or later, with JavaScript ES modules, a plain
HTML/CSS/JavaScript renderer, and GitHub CLI for authenticated API calls.
Development tooling requires Node.js 24 or later; `.node-version` selects the
preferred Node.js 24 development line. There is no application
framework or separately installed runtime SDK.

| Path | Responsibility |
| --- | --- |
| `.github/extensions/github-notifications/extension.mjs` | Development discovery shim importing `src/extension.mjs`. Keep it thin. |
| `src/extension.mjs` | SDK registration, agent-facing actions, panel lifecycle, and shared services. |
| `src/provider/github.mjs`, `src/provider/github-subjects.mjs` | GitHub CLI requests, shared request coordination, and pure subject/response interpretation. |
| `src/shared/model.mjs`, `src/shared/version.mjs` | Browser-safe validation, normalization, grouping, and version helpers. |
| `src/provider/inbox.mjs`, `src/provider/batch.mjs` | Loaded-page state, aggregate summaries, and row, repository, date, and shown-list read/done actions. |
| `src/provider/copilot.mjs`, `src/provider/copilot-prompts.mjs` | Click-confirmed session handoffs through capability-checked host tools, with separate fixed prompt generation. |
| `src/provider/checkout.mjs` | Exact-commit handoff preparation without changing existing branches or working files. |
| `src/provider/server.mjs`, `src/provider/assets.mjs` | Protected per-panel loopback HTTP server, route metadata, asset snapshots, and startup recovery. |
| `src/renderer/` | HTML/CSS, coordination in `app.mjs`, stateless helpers in `presentation.mjs`, and update-notice state and lifecycle in `update-notice.mjs`. |
| `src/provider/settings.mjs`, `src/provider/lock.mjs`, `src/provider/startup.mjs` | User-wide preferences, cross-process locking, and session auto-open. |
| `src/provider/desktop.mjs`, `src/provider/notifier.mjs` | Shared desktop activity checkpoints and platform-specific native delivery. |
| `src/provider/updates.mjs`, `version.json` | Release discovery and the release version. |
| `scripts/` | Release build, package verification, installation, publication, and coverage reporting. |
| `test/`, `test/browser/` | Node unit/integration tests and Playwright browser/accessibility tests. |

Edit source in `src/`, not a user's installed extension or generated `dist/`
output. Development loads source without a build; release builds bundle
`src/extension.mjs` and embed the renderer assets.

Keep the layout shallow: `extension.mjs` wires services, `provider/` owns Node
services, `renderer/` owns browser code, and `shared/` has no Node or DOM
dependencies. Provider and renderer modules may import shared helpers, but not
each other; shared modules must not import either runtime. ESLint checks these
boundaries. Release and installation scripts may also reuse provider and shared
modules. There are no separate packages or barrel exports.

Source renderer modules are served through the explicit allowlist in
`provider/assets.mjs`, not by exposing source directories. Register new browser
dependencies there and update the dependency-free renderer fixture when adding
imports. Keep source coverage discovery recursive and retain the packaged
renderer checks when moving or extracting modules.

Renderer Octicons are generated from the pinned development dependency. Update
the selected names in `scripts/generate-icons.mjs`, then run `npm run icons:generate`;
never hand-edit `src/renderer/octicons.mjs`. Commit regenerated output alongside
dependency updates. `npm run icons:check`, lint, CI, and release builds reject drift.

Keep API methods, input policy, and batch dispatch metadata in the route table
in `provider/server.mjs`; authentication, readiness, origin checks, and error
translation remain shared request guards. Copilot tests are split into
`copilot-handoffs`, `copilot-safety`, and `copilot-host` suites, with shared setup
in `test/fixtures/copilot-handoff.mjs` and the existing synthetic host fixture.

## Implementation conventions

- Match the existing two-space indentation, double quotes, semicolons, explicit
  `.mjs` import extensions, and `node:` imports for built-ins.
- Keep styles in plain CSS and run `npm run format:css` after stylesheet edits.
  Stylelint with `stylelint-config-standard` checks CSS; Prettier enforces
  readable source formatting. ESLint checks JavaScript. Run `npm run lint`
  before completing changes; CI runs these checks and `npm run lint:recovery`
  separately. The recovery check lints the embedded JavaScript and CSS actually
  served when renderer assets are unavailable, using the browser ESLint rules
  and the same Stylelint configuration.
- Prefer existing helpers and injected dependencies over new abstractions or
  runtime packages. `@github/copilot-sdk/extension` is supplied by the host;
  do not add the SDK to this repository's dependencies.
- Keep provider-only Node APIs out of browser modules. Shared modules such as
  `shared/model.mjs` must remain usable by both source and bundled renderers.
- Use `InboxError` for expected domain failures and translate it to HTTP errors
  or `CanvasError` at the boundary. Preserve explicit stale/error states rather
  than returning an apparently successful empty inbox.
- Never use `console.*` in runtime source or the discovery shim. Provider stdout
  carries JSON-RPC; use the injected logger or `session.log` with sanitized
  messages. CLI scripts may print their intended command output.
- Wire behavior changes through every affected schema, provider/HTTP handler,
  renderer control, persistence path, and test. Update the README or relevant
  guide when behavior, settings, prerequisites, or installation steps change.

## Invariants to preserve

### Privacy and request boundaries

- Notification titles and repository names stay out of logs, persisted state,
  and agent-facing results. Use `Inbox.summary()` for agent actions; detailed
  snapshots belong only in the protected renderer. Do not log raw GitHub
  responses, subprocess stderr, credentials, or loopback capability URLs.
- Copilot handoffs are a click-confirmed exception: the selected validated GitHub
  reference and fixed task instructions may enter host tool calls and Copilot
  session history. Never copy notification titles, bodies, or the surrounding
  inbox. Keep handoff endpoints panel-only, use plan-mode summary-first prompts,
  and never mutate read/done state. New handoffs use detached, root-level generic
  sessions in the selected repository; require host support for `detached`.
  Submit the plan-mode prompt through creation's `kickoff` so the host queues
  it until ready; never classify a new session as existing from startup activity.
  PR worktrees start at the validated head commit, including fork PRs.
  PR, CI, and commit handoffs verify the selected commit in the configured checkout before creation,
  fetching the selected ref through GitHub CLI credentials only after confirmation
  or a permitted direct click. Never fall back to another commit or modify an
  existing checkout's branch, files, tags, tracking refs, or `FETCH_HEAD`.
  Generic sessions have no native issue/PR linkage; reuse by repository and generated
  item name as well as existing native links. Existing sessions are navigation-only; do
  not interrupt them. Always confirm the choice to open an existing session or start
  a separate new one, even with routine confirmations off. Never infer failed
  initialization from busy, idle, or unknown activity. Bind fresh-start consent to
  the shown matching sessions and recheck before creation; changed matches require
  a new choice. After setup, checkout, and final session discovery, freshly verify
  the confirmed issue/PR state and release/commit reference immediately before
  session creation. Cached row state cannot authorize that final step. Recheck
  preferences after the request; changed or unavailable context must stop creation.
  Repository cloning needs separate explicit confirmation.
  Honor the user-wide `copilotIntegration` preference (default on) at the panel
  and handoff boundary. Closed and merged PRs offer read-only change summaries,
  not reviews or continued implementation. For closed unmerged PRs, summarize
  the proposed changes, then ask whether the user wants help reopening the PR;
  never reopen it or restore its branch without explicit approval. Merge-queued
  PRs show disabled Copilot controls with status explanations; reject those
  handoffs at the provider boundary too. Recheck PR state before starting;
  a changed task needs a fresh action.
  Resolve fresh PR metadata before checking merge-queue membership. Require the
  queue check for open/draft PRs, not for closed/merged summaries, regardless of
  missing or stale row state.
  Closed issues use summary-only prompts, not fixing or reopening prompts.
  Recheck issue state before starting and reject stale tasks after closure or
  reopening. Discussions summarize the selected thread, replies, and any answer
  without posting or proposing implementation. Commit summaries resolve the
  validated notification reference to a full SHA, verify that exact checkout,
  and summarize its code diff; never substitute a branch or another commit.
  Release summaries require a validated notification release ID and freshly
  verified same-repository release URL. Never infer a tag from notification
  text or substitute the latest release. Share only the validated ID/reference
  and fixed instructions, not release notes or asset contents. Summaries are
  read-only and must not download or execute release assets.
  `confirmCopilotActions` defaults on. An explicit saved opt-out may skip only
  routine confirmations on a fresh row click, never on opening or polling.
  Cloning, inferred CI matches, and existing-or-new session choices still require
  confirmation. Save the popup's opt-out only when the user confirms, not on cancel.
  CI links and handoffs retain the selected run and attempt, including when a
  row opens a failed job. Disclose inferred matches in confirmation and validate
  the exact attempt; never silently replace it with a newer rerun.
- GitHub CLI owns authentication. Keep API traffic in the provider and pinned
  to supported github.com endpoints in packaged releases. Source builds may
  explicitly select an HTTPS development REST API in Settings; freeze that
  target until provider reload, bind pagination and writes to it, and disable
  desktop polling/delivery for custom targets. Never extract or copy credentials
  between hosts or pass them into the renderer. Do not introduce telemetry or
  remote renderer assets.
- Native alerts are the explicit opt-in exception: they send titles, repository
  names, and Windows/optional macOS terminal-notifier alerts' validated GitHub destinations to the OS.
  Do not enable desktop alerts or change preferences
  as a side effect of opening, updating, or testing the extension.
- Bind each panel server to `127.0.0.1` on an ephemeral port. Preserve capability
  authentication, host/origin/fetch-site validation, same-origin POSTs, request
  limits, and restrictive response headers. Do not add permissive CORS.
- Treat notification content as untrusted text and preserve URL validation.
  Maintain accessible names, keyboard/focus behavior, and app theme-token support.
- Keep visible row metadata limited to repository (when needed), type/number,
  confirmed italic `mine`, GitHub reason, and timestamp. Never inject destination hints such as
  "Open repository releases" or "Open GitHub inbox" into it; navigation
  explanations belong in screen-reader descriptions only.

### Inbox and read/done behavior

- Show notifications defaults to All (`matchGitHubInbox: true`) and uses
  `all=true&is_done=false` to mirror GitHub's read and unread inbox. Unread only
  (`matchGitHubInbox: false`) uses `all=false`, as does desktop polling.
  Neither view includes done notifications.
  Search and counts cover **loaded items**, not the entire GitHub inbox.
  Refresh reconciles loaded pages; a failed refresh must not discard usable data.
- Mine matches confirmed authorship of loaded issues, PRs, and discussions, not
  the notification reason. Resolve authorship even for filtered or collapsed
  rows, share the bounded detail cache, and expose incomplete counts explicitly.
  Runtime updates must replace `Inbox.pages`, not mutate its arrays in place,
  so authorship selections stay stable until loaded pages or inbox mode change.
  Keep author/viewer IDs provider-only and in memory; no per-item authorship in
  agent results or desktop polling.
- All views preserve API row order. REST `updated_at` is not the inbox ordering
  key. Preserve cross-repository API positions when regrouping into flat/date
  views; date headings alone sort newest-first. Keep timestamp sorting for
  desktop activity logic, and keep API positions out of agent-facing results.
- Read and done updates require explicit panel actions. Read targets loaded
  unread threads; Done also accepts loaded read threads. Repository, date, and
  shown-list batches target the loaded
  attention/search matches identified by their selection key. Shown-list batches
  may span repositories, but never fetch or include unloaded items. Read is the
  default, and retries retain the original scope and explicitly chosen action
  without adding new items. Keep selection keys out of agent-facing summaries.
  Date actions use the renderer's time zone, not the provider's local zone, and
  retain that date and zone through retries. Keep date context out of agent results.
  Preserve selection checks, per-thread writes, cross-panel reservations,
  cancellation, and retry rules. Never replace this with an unbounded mark-all-read
  endpoint or an agent-facing write action.
- GitHub owns read/done state. Never persist per-notification triage history or
  add a local completion ledger to compensate for missing GitHub API filters.
  Queued row operations retain temporary in-memory completion receipts until a
  state request acknowledges the snapshot the renderer consumed. Keep these out
  of persisted state and agent-facing results, and release them on panel close.
- Respect GitHub polling headers, rate limits, retry waits, and abort signals.
  Force refresh may bypass the polling cache, not rate/error backoff.

### Persistence, desktop delivery, and lifecycle

- Preferences and coordination data are user-wide under
  `${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications/artifacts/`,
  including for project-local source. `instanceId` identifies a panel, not
  persistent user data.
- Preserve unknown stored settings and existing artifacts. Reuse `acquireLock`
  and atomic-write patterns; retain symlink, ownership, and malformed-data
  checks. Report invalid data rather than resetting or silently migrating it.
- Auto-open and desktop notifications default to off. Auto-open runs on provider
  attachment, including resumed sessions, not as a keep-open loop. Use the
  runtime's durable canvas-close events for per-session dismissal and a
  per-session lock for duplicate providers. Never refocus an existing panel or
  reopen a dismissed one; one session's dismissal must not suppress another.
  Bound transient retries and cancel deferred attempts on new conversation
  activity. Global preference changes must not open panels in running sessions.
- Desktop delivery is **at most once across sessions sharing a home**. Persist
  hashed activity before native delivery; never replay failed or interrupted
  batches. Keep the first successful baseline silent and retain watcher
  continuity across overlapping sessions. Registration must remain independent
  of the polling/delivery lock.
- Panel open/close must tolerate races and repeated calls. Clean up servers,
  timers, listeners, watchers, reservations, and outstanding work. Running
  servers keep their loaded asset snapshot; do not mix old provider code with
  newly installed assets or remove a checkout still used by a live session.

## Validation

Run commands from the repository root. Start with the smallest relevant tests;
use broader suites for changes spanning shared behavior. Existing commands are
defined in `package.json`; platform coverage is in
[the test workflow](.github/workflows/tests.yml).

| Check | Command |
| --- | --- |
| Read-only development prerequisite check | `npm run doctor` |
| Targeted Node tests, for example HTTP and inbox changes | `node --test test/server.test.mjs test/inbox.test.mjs` |
| All Node unit and HTTP integration tests | `npm test` (or `node --test test/*.test.mjs`) |
| JavaScript and CSS lint, with no warnings, plus CSS formatting | `npm run lint` |
| JavaScript lint (ESLint) | `npm run lint:js` |
| CSS lint (Stylelint) | `npm run lint:css` |
| CSS formatting check (Prettier, no writes) | `npm run format:css:check` |
| Embedded recovery JavaScript and CSS lint (requires development dependencies) | `npm run lint:recovery` |
| Format source CSS | `npm run format:css` |
| Source coverage with enforced thresholds | `npm run test:coverage` |
| Workflow lint; requires `actionlint` on PATH | `npm run lint:workflows` |
| Release build and packaged integration tests | `npm run build && npm run test:package` |
| Browser and accessibility tests in Chromium and WebKit | `npm run test:browser` |
| One browser engine | `npm run test:browser -- --project=webkit` |
| Isolated native Linux notification transport (requires system test tools) | `npm run test:notifications:linux` |
| Explicit full local validation, stopping on any failure | `npm run check:full` |

Use `npm run dev:fixture` for a standalone synthetic UI preview without GitHub
sign-in or the Copilot host. It shares the browser fixtures and uses temporary
settings and simulated writes/alerts. Select `populated`, `empty`, `long-titles`,
`rate-limited`, or `stale` with `-- --scenario=<name>`; use `-- --help` for usage.
Open its private launcher, not the live notification canvas, for screenshots.
Never share the launcher or capability URL.
See [development](docs/development.md#synthetic-preview) for cleanup and
limitations. `.node-version` selects the preferred development Node major;
keep it aligned with the setup workflow.

For UI changes, refresh `docs/images/github-notifications.png` in the same
change so the README shows the current renderer. Run `npm run screenshot:readme`
to reuse the canonical synthetic rows and repositories with mixed read/unread
notifications, representative issue/PR states, and a failed check run. Keep
Settings closed. See [README screenshot](docs/development.md#readme-screenshot)
for environment requirements and pixel reproducibility limits. Inspect the
captured image and update its README alt text as needed. Never use live
notification content or include private launcher/capability URLs.

Node tests and coverage need no dependency installation and retain Node.js 22
runtime compatibility coverage. For development tools, use Node.js 24 or later.
If packages are missing, use `npm ci --ignore-scripts --engine-strict`.
CI reads `.node-version` for lint, Windows and browser checks, cloud setup, and
release tooling. The runtime test matrix explicitly covers Node.js 22 and 24.
All CI dependency installs must enable strict engine checks; keep the Node.js 22
runtime coverage job and the release bundle's `node22` target.
The recovery lint integration tests run only through the tooling check, not
the dependency-free `test/*.test.mjs` suite.
For missing browser binaries, use
`npx playwright install --with-deps chromium webkit`; this downloads browsers
and may require permission to install Linux system libraries.

Reuse synthetic data from `test/fixtures.mjs`, injected clocks/process runners,
renderer fixtures, SDK stubs, and the isolated browser/package harnesses.
Tests must not require GitHub sign-in, change real read state, send real OS
notifications, or write to the user's real `COPILOT_HOME`.

Native notification checks must stay non-delivering: Windows builds toast XML
with native delivery removed, macOS compiles AppleScript without executing it,
and Linux uses an exclusively owned fake notification service on a private
D-Bus session. Test terminal-notifier discovery and argv with injected filesystem
and process runners; never invoke it to send a real test alert. Its absence permits
AppleScript fallback, but a failed delivery must never retry through another backend.
The Node.js 24 Linux CI job uses `ubuntu-latest` for its system
test packages; Node.js 22 coverage and source lint remain on `ubuntu-slim`.
See [native notification coverage](docs/development.md#native-notification-coverage).

For renderer changes, include relevant renderer tests and browser/accessibility
coverage in both engines. For build, asset-loading, or installer changes,
validate the packaged path as well as source behavior. Do not lower coverage
thresholds or bypass safety tests to make a change pass.

SDK stubs cannot prove compatibility with the installed Copilot build. When
changing SDK wiring, consult the installed SDK guide/types through
`extensions_manage` if available, then reload extensions and inspect the
provider/log. Use `extensionId: project:github-notifications` when needed to
select the local provider. Report when real-host validation is unavailable.

The shared [Copilot setup workflow](.github/workflows/copilot-setup-steps.yml)
preinstalls development tools for cloud-agent sessions and code reviews, not
local app/CLI sessions. It does not install browser binaries or system
libraries. Install those on demand using the command above when the task needs
browser tests; report any network or permission limitations explicitly. Keep
the workflow's Node version, action pins, and verified `actionlint` version
aligned with the test workflow. Setup prepares tools; the agent still selects
and runs the checks relevant to its task.

Workflow CI uses a separate `actionlint` job with the upstream Docker image pinned
by version and verified digest in `ci/actionlint/Dockerfile`.
The local action passes `-color -verbose`; Dependabot's Docker entry manages the
same Dockerfile consumed by CI. Keep its version aligned with Copilot setup's
checksum-verified binary and the installation guidance; the dedicated alignment
test must stay enforced. The Docker action runs on `ubuntu-latest`, not the
unprivileged `ubuntu-slim` runner; source lint remains on `ubuntu-slim`.
Preserve the image's ShellCheck and Pyflakes integrations and read-only permissions.

Browser CI uses a digest-pinned Playwright image with browsers and system
libraries already installed. When updating Playwright, update the image's
version and verified digest in `.github/workflows/tests.yml` together with the
locked npm dependency. Preserve both browser engines and packaged checks.

Documentation-only changes do not need runtime tests unless they affect a
tested contract. Check paths, commands, and consistency; report which checks
actually ran and any checks that could not run.

## Packaging and releases

- `version.json` is the single source of truth for release versions;
  `package.json` describes development tooling. Bump versions only for an
  intended release, not for every change.
- Keep builds self-contained and reproducible. The archive contains only
  `extension.mjs`, `install.mjs`, and `release.json`; the host SDK stays external.
  Do not commit `dist/`, browser reports, coverage output, or runtime artifacts.
- Installation atomically replaces one owned `extension.mjs` while leaving
  `artifacts/` in place. Preserve refusal of downgrades, modified runtimes,
  same-version content changes, and legacy layouts.
- Update checks only discover release metadata; they must not download, execute,
  or install release code. Installation requires the complete release, asset,
  provenance, and checksum verification in the
  [installation guide](docs/installation.md). Never fall back to source or
  checksum-only installation.
- Do not publish, create/move release tags, replace release assets, or migrate a
  user's installation as part of routine code validation. Follow the
  [release process](docs/development.md#publishing-releases) only when explicitly
  requested.
- Do not publish the All inbox behavior before the notification API's
  `is_done` filter is deployed. Older servers may silently ignore the filter.
