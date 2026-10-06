# Unread Notifications

Unread GitHub notifications in the GitHub Copilot app, grouped by repository.
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
- **Settings** offers **Open on new sessions** and **Desktop notifications**,
  both off by default. **Notification sound** offers system-specific sounds
  and defaults to **None**. These settings are saved across sessions.
  Desktop alerts continue
  while the canvas is hidden or Copilot is minimized, as long as its session's
  extension process is running. Closing the last Notifications canvas stops
  the watcher; quitting Copilot stops it too.
- Auto-open runs once per new session, including general chats, before assistant
  work starts. Other canvases do not block it. It does not reopen Notifications
  on session resume, extension reload, or after you close the panel.
- A repository's **Mark N as read** immediately starts marking only its shown,
  loaded notifications, narrowed by search. Older unloaded items are not included.

### Desktop notifications

Enable **Desktop notifications** in Settings and choose a **Notification sound**.
The old per-panel Web Audio chime has been replaced by this setting. No extra
app, package or background service is installed automatically.

| Platform | Backend | Sounds and requirements |
| --- | --- | --- |
| macOS | Built-in `/usr/bin/osascript` | Named system sounds such as Glass, Ping and Submarine. System default uses Glass. Allow notifications for the script sender. |
| Windows 10/11 | Built-in Windows PowerShell and WinRT toasts | Default, IM, Mail, Reminder and SMS. Requires PowerShell's existing Start menu registration and an interactive Windows desktop. No module or new app registration is installed. |
| Linux | `notify-send` and the desktop notification service | Default or themed sound hints. Requires existing libnotify tools and a graphical D-Bus session; missing dependencies produce an error, not an automatic installation. Desktops may ignore sound or silence hints. |

Windows and Linux backends are experimental; actual delivery depends on the
desktop configuration. Commands run on the extension host, so a remote
session does not automatically send alerts to your local computer.

The watcher polls about every two minutes, respecting GitHub polling and rate
limits, and follows additional pages when new activity spans multiple pages.
It sends **one alert per new or updated unread thread**:

- **Title:** `owner/repo`
- **Body:** the GitHub notification's title.

Very long titles are truncated to fit system payload limits. The first
successful poll after enabling, or after all watchers have stopped, establishes
a silent baseline. Search and the panel's loaded pages do not affect alerts.
GitHub's API exposes the latest activity per thread, not every individual
comment or event between polls.

Copies using the same local `COPILOT_HOME` coordinate through a shared lock and
checkpoint, so multiple panels and sessions do not each send the same desktop
alert. Another open copy takes over polling if one closes or crashes. The
checkpoint is saved before invoking the operating system: delivery is
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
extension, or sent to the agent. When you enable desktop notifications, they
are sent to the operating system and **may appear on the lock screen and
remain in notification history**.
Desktop coordination saves timestamps, hashed thread/activity identifiers,
process ownership markers and sanitized error status under the user extension's
`artifacts/` directory. GitHub CLI handles credentials; they never enter the canvas renderer.
There is no telemetry or remote asset loading.

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
