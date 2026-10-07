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

Use the same prompt for a fresh installation or an upgrade, including versions
that do not yet have an update banner:

```text
Install or update the Unread Notifications canvas from
https://github.com/fletchto99/copilot-notifications-canvas as a user-wide
GitHub Copilot extension available across sessions. Follow the repository's
manual steps under "Installation and Updating".

Use the latest published stable GitHub Release, not main or a prerelease.
If no stable release exists, stop and report that. If already current, report
that instead of reinstalling. Do not downgrade a newer installed version.

Read the release notes, fetch the exact release tag into a separate clean
checkout or worktree, and run node scripts/check-release.mjs <release-tag>
before node scripts/install.mjs. Use my existing COPILOT_HOME and GitHub CLI
sign-in.

Preserve the entire installed artifacts directory in place, including
settings.json, autoOpen, darkMode, groupBy, unknown settings, and other files. Do not
delete or recreate that directory, overwrite locally modified runtime files,
or bypass installer safeguards. Report missing prerequisites or permissions
without changing credentials.

Only after installation succeeds, reload extensions in this session and
open Unread Notifications (canvasId: github-notifications). Report the
installed version and remind me to reload extensions in other already-open
sessions. Do not enable auto-update or change any preferences.
```

### Manual installation and updates

Both paths install user-wide into
`${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications`.
Use the same `COPILOT_HOME` for an upgrade as for the original installation.

1. Read the [release notes](https://github.com/fletchto99/copilot-notifications-canvas/releases)
   and choose the latest stable `<release-tag>`. If no stable release is
   published yet, wait for the first release or use a development checkout
   explicitly.
2. Enter your existing repository clone. If you do not have one, create it
   in the directory where you keep repositories:

   ```sh
   git clone https://github.com/fletchto99/copilot-notifications-canvas
   cd copilot-notifications-canvas
   ```

3. From that clone, run the following with a **new, unused worktree path**.
   Set `COPILOT_HOME` first if you use a custom location:

   ```sh
   git fetch origin tag <release-tag>
   git worktree add --detach ../copilot-notifications-release <release-tag>
   cd ../copilot-notifications-release
   node scripts/check-release.mjs <release-tag>
   node scripts/install.mjs
   ```

4. Only after the installer succeeds, ask Copilot:

   > Reload extensions, then open the Unread Notifications canvas.

   Other already-open Copilot sessions need their own extension reload.

**Settings are preserved.** The installer writes a complete runtime, including
its HTML, JavaScript and styles, under `runtimes/<content-hash>/`, then atomically
switches the extension entry point to that version. It never replaces files
inside a published runtime. `.copilot-notifications-install.json` records the
active runtime; its `version.json` is authoritative, not any retained legacy
`version.json` at the extension root.

It leaves `artifacts/` in place, including `artifacts/settings.json`, unknown
settings, and other artifacts, even if a running session saves settings during
the update. Never delete the installed extension to upgrade it. If the installer
reports modified files, stop and preserve those changes; do not bypass its
ownership or concurrency safeguards.

Older runtimes are retained so already-open sessions keep a consistent version,
even if an upgrade rolls back. Upgrades from the original flat layout also keep
its legacy files, including `sound.mjs`, for sessions that have not reloaded.
These retained files are extension code, not notification content. They are not
automatically pruned; do not remove them while a session may still use them.
New runtimes contain no Web Audio playback or its old inbox activity tracking.

Updates use the user-wide installer. A project-local checkout shadows a
user-wide installation in that repository; update that checkout deliberately
instead of expecting a user-wide install to replace it. Persisted settings,
including **Group By**, **Theme**, **Auto-open**, **Desktop notifications** and
**Sound**, are retained.

## Usage

- **Browse and search:** loads up to 50 notifications at a time; **Load more**
  continues while GitHub has more pages. Search and counts cover loaded items only.
- **Mark as read:** mark individual rows in any view. In **repo** mode,
  **Mark N as read** marks only that repository's loaded items matching your search,
  not older unloaded notifications.
- **Refresh:** automatic checks run about every two minutes while visible.
  **Force refresh** in the footer checks loaded pages without waiting for that
  interval; GitHub rate limits and error retry waits still apply.
- **Open GitHub:** the inbox icon beside **Settings** opens your
  [GitHub inbox](https://github.com/notifications).

Settings are saved across sessions:

| Setting | Options |
| --- | --- |
| **Group By** | **repo** (default): alphabetical repositories, newest items first. **none**: one newest-first list. **date**: newest local calendar day first. All use last-updated times. |
| **Theme** | **System** (default), **Dark**, or **Light**. System follows Copilot, falling back to the OS theme. |
| **Auto-open** | Off by default. Opens once per new session, including general chats; not on resume, reload, or after closing the panel. |
| **Desktop notifications** | Off by default. Enable native alerts as described below. |
| **Sound** | System-specific sounds; defaults to **System default**. |

If local UI files fail to load, the recovery page retries automatically. For
persistent failures, reload extensions or reinstall while preserving settings.

### Desktop notifications

Enable **Desktop notifications** in Settings and choose a **Sound**.
Alerts continue while the panel is hidden or Copilot is minimized, provided its
session's extension process is running. Closing the last Notifications canvas
or quitting Copilot stops them. No extra software is installed automatically.

| Platform | Requirements | Sounds |
| --- | --- | --- |
| macOS | Built-in `osascript`; allow notifications for the script sender. | System default or named sounds such as Glass, Ping and Submarine. |
| Windows 10/11 | Built-in Windows PowerShell/WinRT, PowerShell's existing Start menu registration, and an interactive desktop. | Default, IM, Mail, Reminder and SMS. |
| Linux | `notify-send` (libnotify) and a graphical D-Bus notification service. | Default or themed sound hints; desktops may ignore sound or silence hints. |

Windows and Linux support is experimental. Alerts run on the **extension host**;
remote sessions do not automatically notify your local computer.

Checks run about every two minutes, subject to GitHub limits and independent of
search or loaded pages. For each repository, **1-4 new or updated unread threads**
produce individual alerts with the repository name and notification title.
**5 or more in one poll** produce a single `<count> new notifications` summary
with one sound request. Counts reflect new activity, not the whole unread inbox.

The first successful poll after enabling or restarting all watchers is silent,
so existing unread items do not trigger alerts. GitHub reports only the latest
activity per thread, not every event between polls.

Sessions sharing a local `COPILOT_HOME` coordinate to avoid duplicate alerts;
separate machines or homes do not. Delivery is **at most once**: failed or
interrupted batches are not replayed, so alerts can be lost. Reload older
sessions after upgrades; a changed checkpoint format starts a fresh silent baseline.

OS permissions, sound settings and Focus/Do Not Disturb can suppress delivery,
which the extension cannot confirm. Detected errors appear in Settings and the
extension log. The OS controls the sender icon; clicking an alert cannot focus
the canvas.

## Privacy

The extension does not log notification titles or repository names, save them to
disk, or send them to the agent. There is no telemetry or remote asset loading.

**Desktop alerts send repository names and titles to your OS**, which may retain
them in notification history or show them on the lock screen. System settings
control this, not the extension.

The local `artifacts/` directory stores settings and desktop coordination data:
timestamps, hashed activity/thread IDs, watcher/process markers and sanitized
errors. GitHub CLI handles credentials; they never enter the canvas renderer.

GitHub CLI fetches notifications and public release metadata. Update checks do
not send notification content or download or execute release code. Only explicit
**Mark as read** actions send read updates; visiting a linked GitHub page may
also mark a notification read on GitHub.

## Development

Runtime files are in `.github/extensions/github-notifications/`. Open this
repository as a Copilot project, reload extensions after edits, and use extension
**list/inspect** to check the provider and log. Each session uses its own checkout
and loaded asset snapshot; do not delete a checkout while a session uses it.
If both project and user providers are registered, pass
`extensionId: project:github-notifications` when opening the local canvas.

Unit and HTTP integration tests need no dependency installation:

```sh
node --test test/*.test.mjs
```

For lint, coverage and browser checks:

```sh
npm ci --ignore-scripts
npm run lint
npm run lint:workflows  # Requires actionlint on PATH.
npm run test:coverage
npx playwright install --with-deps chromium webkit
npm run test:browser
```

Coverage also works without `npm ci`. Playwright downloads browser binaries and
may need permission to install Linux system libraries. Use `-- --project=webkit`
with `npm run test:browser` to run one engine.

The [test workflow](.github/workflows/tests.yml) defines the platform matrix,
coverage thresholds, lint and Chromium/WebKit accessibility checks. Tests use
synthetic GitHub responses and isolated settings: no sign-in, live read updates,
or OS notifications. SDK stubs do not verify compatibility with a specific
Copilot build; reload and inspect the real extension after SDK changes.
Development dependencies are not included in installed extensions.

### Publishing releases

1. Bump `.github/extensions/github-notifications/version.json` to a new stable
   semantic version and merge into `main`.
2. Run the [Release workflow](.github/workflows/release.yml) from
   **Actions → Release → Run workflow**, selecting **main** and entering the
   version or tag (for example, `0.1.1` or `v0.1.1`). Or use GitHub CLI:

   ```sh
   gh workflow run release.yml \
     --repo fletchto99/copilot-notifications-canvas \
     --ref main \
     -f version=0.1.1
   ```

3. Review the generated release notes and confirm the intended stable version
   is marked **Latest**; the canvas follows `/releases/latest`.

The workflow validates the version, runs PR CI, tags the **exact tested commit**
and publishes the release. Pushing a matching release tag triggers the same checks.
If publication fails after tagging, rerun the failed job; only a tag at the tested
commit can be reused. Never move published tags, overwrite releases or bypass tag
rules. Fix bad releases by publishing a higher version.
