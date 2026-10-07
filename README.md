# Unread Notifications

Unread GitHub notifications in the GitHub Copilot app, grouped by repository or
date, or shown as a single newest-first list. Search, mark rows or repositories
as read, and opt into desktop notifications or auto-open.

![Unread Notifications canvas showing a repository group, search, settings, and mark-as-read controls](docs/images/unread-notifications.png)

## Prerequisites

- A GitHub Copilot app build with extension canvas support (experimental).
- Node.js 22 or later.
- [GitHub CLI](https://cli.github.com/) (`gh`) available to the app and signed
  into **github.com** with `notifications` or `repo` scope.

GitHub.com only; fine-grained personal access tokens are not supported.
See the [installation guide](docs/Installation.md#prerequisites) for CLI
verification requirements and the sign-in check.

<a id="installation"></a>
<a id="updating"></a>

## Installation and Updating

Paste this prompt into Copilot:

```text
Install or update the Unread Notifications canvas as a user-wide Copilot
extension using the latest stable release from:
https://github.com/fletchto99/copilot-notifications-canvas

Follow docs/Installation.md in that repository, including all verification
and settings-preservation requirements. Stop if any check fails.
After installation succeeds, reload extensions and open the canvas.
```

[Manual installation, updates, and migration](docs/Installation.md) cover the
full procedure, verification requirements, and troubleshooting.

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

Open **Settings** for grouping, theme, auto-open, desktop notifications, and sound.
Preferences persist across sessions; auto-open and desktop alerts are off by
default. See the [settings guide](docs/Settings.md) for details and platform support.

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

## Documentation

- [Installation](docs/Installation.md): setup, updates, verification, and migration.
- [Settings](docs/Settings.md): preferences, desktop alerts, and troubleshooting.
- [Development](docs/Development.md): local development, tests, packaging, and releases.
