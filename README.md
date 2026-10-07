# Unread Notifications

Unread GitHub notifications in the GitHub Copilot app, grouped by repository or
date, or shown as a single newest-first list.
Search, mark rows or repositories as read, and opt into desktop
notifications or auto-open.

![Unread Notifications canvas showing a repository group, search, settings, and mark-as-read controls](docs/images/unread-notifications.png)

## Prerequisites

- A GitHub Copilot app build with extension canvas support (experimental).
- Node.js 22 or later.
- [GitHub CLI](https://cli.github.com/) (`gh`) available to the app and signed
  into **github.com** with `notifications` or `repo` scope.

GitHub.com only; fine-grained personal access tokens are not supported.
Check sign-in with `gh auth status --hostname github.com`.

<a id="installation"></a>
<a id="updating"></a>

## Installation and Updating

### Install or update with Copilot

Use the same prompt for a fresh installation or a packaged-release upgrade:

```text
Install or update the Unread Notifications canvas from
https://github.com/fletchto99/copilot-notifications-canvas as a user-wide
GitHub Copilot extension available across sessions. Follow the repository's
manual steps under "Installation and Updating".

Use the latest published stable GitHub Release, not main or a prerelease.
If no stable release exists, stop and report that. If already current, report
that instead of reinstalling. Do not downgrade a newer installed version.

Read the release notes. Download github-notifications-<release-tag>.tar.gz
and SHA256SUMS from that exact release. Verify the archive's SHA-256 before
extracting it into a new directory, then run node install.mjs <release-tag>
from the extracted package. Use my existing COPILOT_HOME and GitHub CLI sign-in.
Do not install from a source checkout, main, or a local build. Stop if the
package is missing or verification fails; do not fall back to source.

Preserve the entire installed artifacts directory in place, including
settings.json, autoOpen, darkMode, groupBy, unknown settings, and other files. Do not
delete or recreate that directory, overwrite locally modified runtime files,
or bypass installer safeguards. Report missing prerequisites or permissions
without changing credentials.

If a legacy/source installation is detected, stop and report the repository's
one-time migration instructions. Do not migrate it while old extension
processes may be running.

Only after installation succeeds, reload extensions in this session and
open Unread Notifications (canvasId: github-notifications). Report the
installed version and remind me to reload extensions in other already-open
sessions. Do not enable auto-update or change any preferences.
```

### Manual installation and updates

Packaged releases (starting with **v0.2.0**) install user-wide into
`${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications`.
Use the same `COPILOT_HOME` for an upgrade as for the original installation.

1. Read the [release notes](https://github.com/fletchto99/copilot-notifications-canvas/releases)
   and choose the latest stable `<release-tag>`. If no stable release is
   published with the package assets yet, stop. GitHub's automatically
   generated **Source code** downloads are not installation packages.
2. Download into a **new, unused directory** and verify before extracting.
   Set `COPILOT_HOME` first if you use a custom location. Replace the example
   tag below with your chosen stable release:

   ```sh
   tag=v0.2.0
   mkdir github-notifications-release &&
   cd github-notifications-release &&
   gh release download "$tag" \
     --repo fletchto99/copilot-notifications-canvas \
     --pattern "github-notifications-$tag.tar.gz" --pattern SHA256SUMS &&
   sha256sum -c SHA256SUMS &&
   mkdir package &&
   tar -xzf "github-notifications-$tag.tar.gz" -C package &&
   cd package &&
   node install.mjs "$tag"
   ```

   On macOS, replace `sha256sum -c SHA256SUMS` with
   `shasum -a 256 -c SHA256SUMS`. These are shell commands; on Windows, use
   a shell with `tar` and a SHA-256 utility, or verify with PowerShell's
   `Get-FileHash -Algorithm SHA256` before extracting. Never continue after
   a failed download or checksum check.

   The archive contains only `extension.mjs`, `install.mjs`, and `release.json`.
   No clone, npm install, build tools, or separately installed Copilot SDK
   are needed. The installer also verifies the package's file hashes and
   version, refuses downgrades, and does nothing if already current.

3. Only after the installer succeeds, ask Copilot:

   > Reload extensions, then open the Unread Notifications canvas.

   Other already-open Copilot sessions need their own extension reload.

**Settings are preserved.** The installed layout is one self-contained
`extension.mjs` beside `artifacts/`. HTML, minified browser JavaScript and CSS,
provider code, version, and ownership metadata are all in that bundle. The
Copilot SDK remains host-provided. Upgrades stage and verify the replacement,
then activate it with one atomic file rename. There is no separate installed
manifest to get out of sync and no accumulating runtime directories.

It leaves `artifacts/` in place, including `artifacts/settings.json`, unknown
settings, and other artifacts, even if a running session saves settings during
the update. Never delete the installed extension to upgrade it. If the installer
reports modified files, stop and preserve those changes; do not bypass its
ownership or concurrency safeguards.

Already-running packaged providers retain their own loaded code and embedded
assets, including when opening another panel after an upgrade. They need an
extension reload to pick up the new version. An error before activation leaves
the previous bundle intact; an interruption after activation leaves a complete
new bundle. A retry recognizes whichever version is installed.

Updates use the user-wide installer. A project-local checkout shadows a
user-wide installation in that repository; update that checkout deliberately
instead of expecting a user-wide install to replace it. Persisted settings,
including **Group By**, **Theme**, **Auto-open**, **Desktop notifications** and
**Sound**, are retained.

### One-time migration from source installations

The first packaged release is a new baseline, not an in-place upgrade for the
old flat-file or `runtimes/<hash>/` layouts. The installer deliberately refuses
those layouts rather than deleting code that an old session might still need.

1. Stop **all** Copilot app/CLI sessions and extension processes using the old
   installation. Closing a canvas or reloading only one session is not enough.
   Perform the migration from an external terminal after they have stopped.
2. Locate `${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications`.
   Make a backup outside every extension discovery directory. Move its old
   code and metadata into that backup, including retained `runtimes/`, but
   **leave `artifacts/` exactly where it is**. Preserve locally modified files
   in the backup; do not delete or overwrite them. The installation directory
   should now contain only `artifacts/` (or be empty).
3. Install the verified release package using the steps above, restart Copilot,
   and open the canvas. Keep the backup until you have confirmed the new
   installation and settings. Future packaged updates need no such migration.

## Usage

- **Settings > Group By** has three saved options:
  - **none**: no group headers; all loaded, matching notifications are sorted
    globally by their last-updated date, newest first.
  - **repo** (default): repository groups are sorted alphabetically by full name
    (`owner/repo`), with newest notifications first within each group.
  - **date**: notifications are grouped by their last-updated calendar day in
    your local time zone, with newest days and notifications first.
  Repository names appear on each row in **none** and **date** modes.
- The canvas loads up to 50 notifications initially. **Load more** fetches up to
  50 more at a time, with no fixed total cap while GitHub has more pages.
  Search covers loaded notifications only.
  The count shows loaded unread notifications, adds a matching count while
  searching, and disappears when you are all caught up. Search and Settings
  stay in place.
- If the canvas cannot read its local UI files, it opens a recovery page and
  retries in the background with exponential backoff, up to 30 seconds between
  attempts. The inbox appears automatically after recovery, without reopening
  the panel. Closing the panel stops retries.
  Desktop polling for this panel starts only after its assets are ready;
  watchers for other ready panels continue normally.
  Socket-binding failures are retried three times before opening fails: the app
  cannot display a web canvas without a listening local server. Errors include
  a safe operating-system error code when available. For persistent failures,
  reload extensions or reinstall the canvas while preserving its settings.
- Notifications refresh about every two minutes while the canvas is visible.
  GitHub polling and rate limits can delay updates. The footer shows relative
  check times; hover over the status for exact times and the visibility reminder.
- **Force refresh**, beside the checked time in the footer, checks loaded pages
  immediately without waiting for the polling
  interval. It stays clickable; clicks during an active operation queue one
  follow-up refresh. GitHub rate-limit and error retry waits still apply and
  are shown as errors.
- The inbox icon to the left of **Settings** opens your
  [GitHub inbox](https://github.com/notifications) in a new tab.
- **Settings > Theme**, above **Group By**, offers **System** (default),
  **Dark**, and **Light**. System follows Copilot's theme, falling back to the
  OS theme when the app does not provide one. Choose System again to return
  to automatic theming. Your choice is saved across sessions and loaded when a
  panel opens or becomes visible. Existing saved Dark mode choices are preserved.
- **Auto-open** and **Desktop notifications** are off by default.
  **Sound** offers system-specific sounds
  and defaults to **System default**. These settings are saved across sessions.
  Desktop alerts run while the canvas is in the foreground, hidden, or
  Copilot is minimized, as long as its session's
  extension process is running. Closing the last Notifications canvas stops
  the watcher; quitting Copilot stops it too.
- Auto-open runs once per new session, including general chats, before assistant
  work starts. Other canvases do not block it. It does not reopen Notifications
  on session resume, extension reload, or after you close the panel.
- A repository's **Mark N as read** immediately starts marking only its shown,
  loaded notifications, narrowed by search. Older unloaded items are not included.
  This action is available in **repo** mode; individual **Mark as read** buttons
  remain available in every grouping mode.

### Desktop notifications

Enable **Desktop notifications** in Settings and choose a **Sound**.
The old per-panel Web Audio chime has been replaced by this setting. No extra
app, package or background service is installed automatically.

| Platform | Backend | Sounds and requirements |
| --- | --- | --- |
| macOS | Built-in `/usr/bin/osascript` | Named system sounds such as Glass, Ping and Submarine, or the native system default. Allow notifications for the script sender. |
| Windows 10/11 | Built-in Windows PowerShell and WinRT toasts | Default, IM, Mail, Reminder and SMS. Requires PowerShell's existing Start menu registration and an interactive Windows desktop. No module or new app registration is installed. |
| Linux | `notify-send` and the desktop notification service | Default or themed sound hints. Requires existing libnotify tools and a graphical D-Bus session; missing dependencies produce an error, not an automatic installation. Desktops may ignore sound or silence hints. |

Windows and Linux backends are experimental; actual delivery depends on the
desktop configuration. Commands run on the extension host, so a remote
session does not automatically send alerts to your local computer.

The watcher polls about every two minutes, respecting GitHub polling and rate
limits, and follows additional pages when new activity spans multiple pages.
For each repository with **1-4 new or updated unread threads in a poll**, it
sends one alert per thread:

- **Title:** `owner/repo`
- **Body:** the GitHub notification's title.

At **5 or more new or updated unread threads from the same repository in a
single poll**, it sends one summary alert instead:

- **Title:** `owner/repo`
- **Body:** `<count> new notifications`

Each summary makes one notification sound request, not one per thread. Counts
include only newly detected activity, not the repository's entire unread inbox.
Repositories are grouped independently; five notifications from five different
repositories still produce five individual alerts.

Very long titles are truncated to fit system payload limits. The first
successful poll after enabling, or after all watchers have stopped, establishes
a silent baseline using GitHub timestamps rather than the local completion
clock. The initial load includes all pages sharing the newest timestamp, so
same-second arrivals can be distinguished from existing notifications. Search
and the panel's loaded pages do not affect alerts.
GitHub's API exposes the latest activity per thread, not every individual
comment or event between polls.

Copies using the same local `COPILOT_HOME` coordinate through a shared lock and
checkpoint, so multiple panels and sessions do not each send the same desktop
alert. Another open copy takes over polling if one closes or crashes. The
watchers record their shared lifetime when joining, independently of delivery,
so opening a second canvas during an alert does not restart the baseline.
After an upgrade, reload all older sessions to use the same coordination format.
The first use of an upgraded checkpoint establishes a fresh silent baseline.

The checkpoint is saved before invoking the operating system: delivery is
**at most once**, not guaranteed exactly once. A crash or delivery failure can
lose alerts from the current batch; they are not retried. Separate machines or separate `COPILOT_HOME` directories do not
share this coordination.

The sender's icon is controlled by the operating system and is not necessarily
branded as GitHub Copilot. System notification, sound and Focus/Do Not Disturb
settings can suppress a banner or sound even when the command succeeds.
The extension cannot confirm that the operating system displayed it. Detected
failures appear in Settings and the extension log. Desktop alerts do not
support clicking to focus the canvas.

## Privacy

Notification titles and repository names are not logged, saved to disk by the
extension, or sent to the agent.

> **Native notification content:** If desktop notifications are enabled,
> repository names and notification titles are sent to your operating system.
> The OS may store this content on disk in its notification history and display
> it on the lock screen, according to your system settings. The extension does
> not control the OS's storage or retention of this content.

Desktop coordination saves timestamps, hashed thread/activity identifiers,
watcher group IDs, process ownership markers and sanitized error status under
the user extension's `artifacts/` directory. GitHub CLI handles credentials;
they never enter the canvas renderer.
There is no telemetry or remote asset loading.

The extension fetches notifications and public release metadata from GitHub
through GitHub CLI. Release checks do not send notification content or download
or execute release code. Only explicit row or repository
**Mark as read** clicks send read updates. Visiting a linked GitHub page may also
mark that notification read on GitHub.

## Development

Provider modules and renderer assets live in `src/`. The one-line entry point
at `.github/extensions/github-notifications/extension.mjs` imports
`src/extension.mjs`, so opening this repository as a Copilot project loads the
local source directly without a build. After edits, reload extensions and use
extension **list/inspect** to check the provider and its log.

Release builds also start from `src/extension.mjs`, not the development entry
point. The installer still writes only the bundled `extension.mjs` under the
user-wide `extensions/github-notifications/` directory.

Each Copilot session runs its own provider process. Its project extension reads
from that session's checkout; sessions using separate worktrees do not load each
other's edits. Panels have separate loopback ports and access tokens. After a
successful load, each server retains its in-memory asset snapshot until closed.
Reload extensions to pick up provider changes. Avoid deleting or replacing a
checkout while a session still uses it.

Canvas routing is scoped to the session and provider (`project:github-notifications`
or `user:github-notifications`), with `github-notifications` as the canvas type
and an `instanceId` for each panel. If both providers are registered, pass an
explicit `extensionId` when opening the canvas. User-wide settings and desktop
alert coordination remain shared across sessions using the same `COPILOT_HOME`.

Run the unit and HTTP integration tests without installing dependencies:

```sh
node --test test/*.test.mjs
```

The [test workflow](.github/workflows/tests.yml) runs on pull requests, pushes to
`main`, and before publication by the release workflow:

- Unit and integration tests on Linux with Node.js 22 and 24, and macOS with
  Node.js 24.
- Source-only Node.js coverage on Linux/Node.js 22, requiring at least 90% lines,
  85% branches, and 90% functions. Tests and development tooling do not count.
  A separate guard fails if any runtime, installer, or publication module is
  missing from the report, including the renderer and development entry point.
  The release-only builder is exercised separately by package integration tests.
- Correctness-focused ESLint and checksum-verified actionlint. Browser and Node
  globals are checked separately; extension providers must not use `console`.
- Chromium and WebKit smoke tests against the real loopback server, including
  WCAG 2.1 A/AA axe checks and light/dark layouts at 320, 480, and 960 pixels.
  Browser reports, layout screenshots, and failure traces are retained for 14 days.

All tests use synthetic GitHub responses. They need no GitHub sign-in, make no
live GitHub requests, and cannot mark real notifications read. Browser tests
stub native desktop delivery, block unexpected external requests, and fail on
browser errors. Tests never show operating-system notifications. Temporary
settings and lifecycle-test `COPILOT_HOME` directories are isolated and removed
after each test. The SDK-boundary stub tests our registration and lifecycle
wiring, not compatibility with a particular Copilot build; still reload and
inspect the real extension when changing SDK integration.

The repository's `.npmrc` selects the public npm registry for development
dependencies. Install them and run the checks locally:

```sh
npm ci --ignore-scripts
npm run lint
npm run lint:workflows  # Requires actionlint on PATH (CI uses v1.7.12).
npm run test:coverage
npx playwright install --with-deps chromium webkit
npm run test:browser
```

The coverage command also works without `npm ci`. Playwright's install command
downloads browser binaries and, on Linux, may require permission to install
system libraries. To run one engine, use
`npm run test:browser -- --project=webkit`. The extension itself remains
dependency-free apart from the SDK supplied by Copilot; development packages
are never copied by the installer. Dependabot groups weekly updates for pinned
GitHub Actions and npm development dependencies.

Ordinary CI does not build or publish release assets. To validate packaging
locally (not to distribute a development installation):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build -- v0.2.0
npm run test:package
```

Use the tag matching the repository-root `version.json`. The pinned esbuild dependency is
build-time only. Generated archives and checksums go in ignored `dist/`; build
output is not committed. The package tests extract the archive, run its
installer in temporary Copilot homes, and load its provider with a stub host SDK.

### Publishing releases

Use stable semantic versions (`vMAJOR.MINOR.PATCH`) so users receive deliberate,
tested updates with release notes instead of every merge. Bump
the repository-root `version.json` in the release PR. This is the single source
of truth for the release version; `package.json` only describes development tooling.

After merging the version change into `main`, tag that exact commit and push
the tag. For example, from an up-to-date checkout of the intended release commit:

```sh
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

Only a `v*` tag push triggers the [Release workflow](.github/workflows/release.yml).
There is no manual or branch-push release build. The workflow validates the
stable tag against `version.json`, runs the same test matrix, coverage,
lint, and browser/accessibility checks as PR CI, then bundles and minifies the
runtime and tests the actual archive. It verifies the tag still points to the
**exact tested commit** before publication. It never creates or moves tags,
bumps a version, or commits generated output.

Publication first checks every page of releases and refuses an existing
published release or draft with the requested tag. It then uses GitHub CLI's
single upload-and-publish command. The CLI creates a draft with generated notes,
uploads `github-notifications-<tag>.tar.gz` and `SHA256SUMS`, then publishes
that exact release by ID and marks it **Latest**. The script never
looks up a release by tag to edit or publish it. The canvas follows
`/releases/latest`, so it does not advertise a draft with missing assets.
Publication is serialized.
Review the generated notes for behavior changes and update guidance.

An existing release or asset is never overwritten. A failure before draft
creation can be retried. If an upload/publication failure leaves a draft,
inspect it first; remove only that incomplete draft (not its tag) before
rerunning the job. Never replace assets on an already-published release.

Publish increasing versions; never move a published tag or reuse a version.
For a bad release, publish a fixed version rather than modifying existing
release code. Restrict `v*` tag creation with repository rules if more
contributors gain write access.

Installations from before the update banner cannot discover releases
retroactively. Follow the one-time source migration above rather than their
old source-based installation instructions.
