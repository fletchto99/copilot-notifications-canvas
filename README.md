# Unread Notifications

Unread GitHub notifications in the GitHub Copilot app, grouped by repository.
Search, mark rows or repositories as read, and opt into sound or auto-open.

![Unread Notifications canvas showing a repository group, search, settings, and mark-as-read controls](docs/images/unread-notifications.png)

## Prerequisites

- A GitHub Copilot app build with extension canvas support (experimental).
- Node.js 22 or later.
- [GitHub CLI](https://cli.github.com/) (`gh`) available to the app and signed
  into **github.com** with `notifications` or `repo` scope.

GitHub.com only; fine-grained personal access tokens are not supported.
Check sign-in with `gh auth status --hostname github.com`.

## Installation

### Install with Copilot

Have Copilot install this extension for you with this prompt:

```text
Install the Unread Notifications canvas from
https://github.com/fletchto99/copilot-notifications-canvas as a user-wide
GitHub Copilot extension available across sessions. Follow the repository's
manual "Install for all projects" steps using node scripts/install.mjs.
Preserve existing settings and do not overwrite locally modified files or
bypass installer safeguards. Use my existing GitHub CLI sign-in; report
missing prerequisites or permissions without changing credentials. After
installation succeeds, reload extensions and open Unread Notifications
(canvasId: github-notifications).
```

### Install for all projects

Manual alternative, from the directory where you keep repositories:

```sh
git clone https://github.com/fletchto99/copilot-notifications-canvas
cd copilot-notifications-canvas
node scripts/install.mjs
```

Installs user-wide into `${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications`.
Upgrades preserve settings and refuse to overwrite modified or unrelated files.

After installation finishes, ask Copilot:

> Reload extensions, then open the Unread Notifications canvas.

## Usage

- Notifications refresh about every two minutes while the canvas is visible.
  GitHub polling and rate limits can delay updates.
- **Settings** offers sound and **Open on new sessions**, both off by default.
  Sound is per-panel and resets when the panel reloads or reopens.
- A repository's **Mark N as read** immediately starts marking only its shown,
  loaded notifications, narrowed by search. Older unloaded items are not included.

## Privacy

Notification content stays in local memory. It is not logged, saved to disk, or
sent to the agent. GitHub CLI handles credentials; they never enter the canvas
renderer. There is no telemetry or remote asset loading.

The extension fetches notifications from GitHub. Only explicit row or repository
**Mark as read** clicks send read updates. Visiting a linked GitHub page may also
mark that notification read on GitHub.

## Development

Runtime files are in `.github/extensions/github-notifications/`. Open this
repository as a Copilot project to work on its local extension. After edits,
reload extensions and use extension **list/inspect** to check the provider and
its log.

Run the tests:

```sh
node --test test/*.test.mjs
```

The [test workflow](.github/workflows/tests.yml) runs the same suite on pull
requests and pushes to `main`. Tests use synthetic fixtures and need no dependency
installation, GitHub sign-in, or external network access.
