# Unread Notifications

Unread GitHub notifications in the GitHub Copilot app, grouped by repository or
date, or shown as a single newest-first list. Search, mark rows or repositories
as read or done, and opt into desktop notifications or auto-open.

![Unread Notifications canvas showing attention tabs with counts, search, settings, and a notification with a mark-as-read action](docs/images/unread-notifications.png)

## Prerequisites

- A GitHub Copilot app build with extension canvas support (experimental).
- Node.js 22 or later.
- [GitHub CLI](https://cli.github.com/) (`gh`) available to the app and signed
  into **github.com** with `notifications` or `repo` scope.

GitHub.com only; fine-grained personal access tokens are not supported.
See the [installation guide](docs/installation.md#prerequisites) for CLI
verification requirements and the sign-in check.

<a id="installation"></a>
<a id="updating"></a>

## Installation and Updating

Paste this prompt into Copilot:

```text
Install or update the Unread Notifications canvas as a user-wide Copilot
extension using the latest stable release from:
https://github.com/fletchto99/copilot-notifications-canvas

Follow docs/installation.md in that repository, including all verification
and settings-preservation requirements. Stop if any check fails.
After installation succeeds, reload extensions and open the canvas.
```

[Manual installation and updates](docs/installation.md) cover the
full procedure, verification requirements, and troubleshooting.

## Usage

- **Browse and search:** loads up to 50 notifications at a time; **Load more**
  continues while GitHub has more pages. Issue and PR numbers appear beside the
  type below each title (for example, `Issue #42` or `Pull Request #42`).
  Search matches titles, numbers and repositories;
  search and counts cover loaded items only. Numbers are omitted when GitHub
  does not provide a valid issue or PR link.
- **Attention tabs:** new panels start on **All** (all loaded unread items).
  **Review requested** shows review requests, **Mentioned** includes personal
  and team mentions, **Assigned** shows assignments, and **Participating**
  shows threads you authored or commented on. These use GitHub's notification
  reason, not a full history of your involvement; a thread's reason can change.
  Tabs combine with search in every grouping mode and stay selected during
  refresh and pagination. Each tab's count, such as **Review requested (3)**,
  includes all loaded unread items in that category, independent of search.
  The status line reports matches for the selected tab and search.
  Use Left/Right Arrow or Home/End to switch tabs.
  When tabs do not all fit, edge arrows scroll the strip without changing your
  selected filter. The scrollbar stays hidden; touch and trackpad scrolling
  still work. Passive count updates only scroll the tab strip, not the page.
  Clearing the search leaves the selected attention tab unchanged.
- **Mark as read:** use the open-envelope icon on an individual row in any view.
  In **repo** mode, groups with multiple matching notifications also offer
  **Mark N as read**. This marks only that repository's loaded items matching
  your attention tab and search, not hidden or older unloaded notifications.
- **Mark as done:** use the checkmark icon to mark an individual row completed on
  GitHub in any view.
  This is separate from marking it read. Both actions remove the row from this
  unread-only canvas after GitHub confirms success. Done status is stored only
  by GitHub; the canvas keeps no local completion history. Use GitHub's inbox
  to view read or done notifications.
  In **repo** mode, the arrow beside **Mark N as read** opens a dropdown with
  **Mark N as done**, limited to that repository's shown, loaded attention and
  search matches.
  Read stays the default; choosing Done never changes future defaults.
  Both repository actions show progress, allow stopping remaining requests, and
  retry only unchanged, still-shown remaining items with the original action.
  Both row icons use compact outlined buttons with immediate hover and
  keyboard-focus tooltips. Press Escape to dismiss a tooltip; Tab moves between
  the title, read, and done controls. The last-updated time appears with the
  dot-separated metadata beneath each title, without a redundant unread label.
- **Responsive layout:** panel padding and header spacing stay consistent while
  resizing. Header text, notification titles, and metadata remain visible.
  Timestamps stay in the metadata; both row actions remain available in narrow panels.
- **Refresh:** automatic checks run about every 60 seconds while the canvas is
  visible and pause while hidden. Returning to the foreground refreshes immediately.
  Longer GitHub polling intervals apply to automatic checks. Foreground returns
  and the **Force refresh** icon immediately left of **Settings** check loaded
  pages without waiting for the polling interval, but cannot bypass rate limits
  or error retry waits. Its theme-matched tooltip appears immediately on hover
  or keyboard focus and reports seconds since the last successful update.
  Its elapsed time updates every 15 seconds while visible. Inbox and Settings
  use the same immediate tooltips; press Escape to dismiss them.
  When desktop alerts are enabled, foreground checks feed the same results to
  the desktop watcher. It continues checking about every minute while
  the canvas is hidden; the OS controls when alerts appear.
- **Open GitHub:** the inbox icon beside **Settings** opens your
  [GitHub inbox](https://github.com/notifications).

Open **Settings** for grouping, theme, auto-open, desktop notifications, and sound.
Preferences persist across sessions; auto-open and desktop alerts are off by
default. See the [settings guide](docs/settings.md) for details and platform support.

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
**Mark as read** or **Mark as done** actions send notification updates; visiting a
linked GitHub page may also mark a notification read on GitHub.

## Documentation

- [Installation](docs/installation.md): setup, updates, and verification.
- [Settings](docs/settings.md): preferences, desktop alerts, and troubleshooting.
- [Development](docs/development.md): local development, tests, packaging, and releases.
- [Agent guidance](AGENTS.md): repository conventions, invariants, and validation.
