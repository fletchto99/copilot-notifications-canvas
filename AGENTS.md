# Repository guidance for agents

These instructions apply to the whole repository. Keep shared guidance here;
`.github/copilot-instructions.md` is the Copilot entry point. Read the relevant
implementation and tests before changing behavior. The [README](README.md) and
[guides](README.md#documentation) document the user-facing contract,
installation safeguards, and release process.

## Project and source layout

Unread Notifications is a GitHub Copilot canvas extension for **github.com**.
It uses Node.js 22 or later, JavaScript ES modules, a plain HTML/CSS/JavaScript
renderer, and GitHub CLI for authenticated API calls. There is no application
framework or separately installed runtime SDK.

| Path | Responsibility |
| --- | --- |
| `.github/extensions/github-notifications/extension.mjs` | Development discovery shim importing `src/extension.mjs`. Keep it thin. |
| `src/extension.mjs` | SDK registration, agent-facing actions, panel lifecycle, and shared services. |
| `src/github.mjs`, `src/model.mjs` | GitHub CLI requests, caching, rate limits, validation, normalization, and grouping. |
| `src/inbox.mjs`, `src/batch.mjs` | Loaded-page state, aggregate summaries, and row and repository read/done actions. |
| `src/server.mjs`, `src/assets.mjs` | Protected per-panel loopback HTTP server, asset snapshots, and startup recovery. |
| `src/index.html`, `src/app.mjs`, `src/styles.css` | Renderer, controls, accessibility, and themes. |
| `src/settings.mjs`, `src/lock.mjs`, `src/startup.mjs` | User-wide preferences, cross-process locking, and session auto-open. |
| `src/desktop.mjs`, `src/notifier.mjs` | Shared desktop activity checkpoints and platform-specific native delivery. |
| `src/updates.mjs`, `src/version.mjs`, `version.json` | Release discovery and version handling. |
| `scripts/` | Release build, package verification, installation, publication, and coverage reporting. |
| `test/`, `test/browser/` | Node unit/integration tests and Playwright browser/accessibility tests. |

Edit source in `src/`, not a user's installed extension or generated `dist/`
output. Development loads source without a build; release builds bundle
`src/extension.mjs` and embed the renderer assets.

## Implementation conventions

- Match the existing two-space indentation, double quotes, semicolons, explicit
  `.mjs` import extensions, and `node:` imports for built-ins.
- Prefer existing helpers and injected dependencies over new abstractions or
  runtime packages. `@github/copilot-sdk/extension` is supplied by the host;
  do not add the SDK to this repository's dependencies.
- Keep provider-only Node APIs out of browser modules. Shared modules such as
  `model.mjs` must remain usable by both source and bundled renderers.
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
- GitHub CLI owns authentication. Keep API traffic in the provider and pinned
  to supported github.com endpoints; never pass credentials into the renderer.
  Do not introduce telemetry or remote renderer assets.
- Native alerts are the explicit opt-in exception: they send titles and
  repository names to the OS. Do not enable desktop alerts or change preferences
  as a side effect of opening, updating, or testing the extension.
- Bind each panel server to `127.0.0.1` on an ephemeral port. Preserve capability
  authentication, host/origin/fetch-site validation, same-origin POSTs, request
  limits, and restrictive response headers. Do not add permissive CORS.
- Treat notification content as untrusted text and preserve URL validation.
  Maintain accessible names, keyboard/focus behavior, and app theme-token support.

### Inbox and read/done behavior

- Search and counts cover **loaded unread items**, not the entire GitHub inbox.
  Refresh reconciles loaded pages; a failed refresh must not discard usable data.
- Read and done updates require explicit panel actions. Row actions target a
  loaded unread thread; repository batches target the shown, search-matching
  selection. Read is the default, and retries retain the explicitly chosen
  action. Preserve selection checks, per-thread writes, cross-panel reservations,
  cancellation, and retry rules. Never replace this with an unbounded mark-all-read
  endpoint or an agent-facing write action.
- GitHub owns read/done state. Never persist per-notification triage history or
  add a local completion ledger to compensate for missing GitHub API filters.
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
- Auto-open and desktop notifications default to off. Auto-open is once per new
  session, not on resume, reload, or panel closure.
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
| Targeted Node tests, for example HTTP and inbox changes | `node --test test/server.test.mjs test/inbox.test.mjs` |
| All Node unit and HTTP integration tests | `npm test` (or `node --test test/*.test.mjs`) |
| JavaScript lint, with no warnings | `npm run lint` |
| Source coverage with enforced thresholds | `npm run test:coverage` |
| Workflow lint; requires `actionlint` on PATH | `npm run lint:workflows` |
| Release build and packaged integration tests | `npm run build && npm run test:package` |
| Browser and accessibility tests in Chromium and WebKit | `npm run test:browser` |
| One browser engine | `npm run test:browser -- --project=webkit` |

Node tests and coverage need no dependency installation. If a tooling check
fails because development packages are missing, use `npm ci --ignore-scripts`.
For missing browser binaries, use
`npx playwright install --with-deps chromium webkit`; this downloads browsers
and may require permission to install Linux system libraries.

Reuse synthetic data from `test/fixtures.mjs`, injected clocks/process runners,
renderer fixtures, SDK stubs, and the isolated browser/package harnesses.
Tests must not require GitHub sign-in, change real read state, send real OS
notifications, or write to the user's real `COPILOT_HOME`.

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
