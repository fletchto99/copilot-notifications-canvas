# Settings

[README](../README.md) | [Usage](usage.md) | [Installation](installation.md) | [Development](development.md)

Open **Settings** in the canvas to change these preferences. They are saved
across sessions and preserved during packaged upgrades.

| Setting | Default | Options and behavior |
| --- | --- | --- |
| Group By | Repository | **Repository**: alphabetical repositories, newest items first. **All notifications**: one collapsible, newest-first group. **Date**: newest local calendar day first. All use last-updated times. |
| Theme | System | **System** follows Copilot, falling back to the OS theme. **Dark** and **Light** override it. |
| Auto-open | Off | Opens once per new session, including general chats; not on resume, reload, or after closing the panel. |
| Desktop notifications | Off | Enables native alerts while a Notifications canvas is open and its extension process is running. |
| Sound | System default | System-specific sounds for desktop alerts; see the platform table below. |

The saved grouping values remain `repo`, `none`, and `date`; the display labels
do not change existing preferences. Press Escape, click outside Settings, or move
keyboard focus outside it to close the panel.

## Desktop notifications

Enable **Desktop notifications** and choose a **Sound**. Alerts continue while
the panel is hidden or Copilot is minimized, provided its session's extension
process is running. Closing the last Notifications canvas or quitting Copilot
stops them. No extra software is installed automatically.

### Platform support

| Platform | Requirements | Sounds |
| --- | --- | --- |
| macOS | Built-in `osacompile`, `plutil`, `codesign` and `open`; allow notifications for **Unread Notifications**. | System default or named sounds such as Glass, Ping and Submarine. |
| Windows 10/11 | Built-in Windows PowerShell/WinRT, PowerShell's existing Start menu registration, and an interactive desktop. | Default, IM, Mail, Reminder and SMS. |
| Linux | `notify-send` (libnotify) and a graphical D-Bus notification service. | Default or themed sound hints; desktops may ignore sound or silence hints. |

Windows and Linux support is experimental. Alerts run on the **extension host**;
remote sessions do not automatically notify your local computer.

On macOS, the extension builds a small, locally ad-hoc-signed **Unread
Notifications** helper app using the built-in tools. It has its own notification
sender identity, so clicking an alert does not launch Script Editor. Clicking
tries to open the GitHub Copilot app; if macOS cannot open it, the helper opens
`https://github.com/notifications` in the default browser. This brings up the app,
not a specific session or canvas. Delivering an alert does not activate either
destination.

The extension launches the helper with argument data rather than automating
another application through AppleEvents; no new Automation permission is needed.

The helper and its integrity receipt live in a versioned `macos-notifier-*`
directory under the extension's shared `artifacts/` directory. They contain only
static code, bundle metadata and integrity hashes, never notification titles,
repository names or per-notification destinations. Existing helper versions and
unrelated artifacts are preserved. Helper generation occurs only when an
opted-in watcher has an alert to send; opening a canvas does not create one.
The helper quits after handling an event and is reopened by macOS on a click.
No third-party notifier or developer tools are downloaded.

Previously delivered Script Editor alerts keep their original sender. Allow
notifications for **Unread Notifications** in System Settings for new alerts;
prior permissions for the script sender do not necessarily carry over.

### Polling and delivery

While the canvas is visible, its checks feed the same results to desktop alerts,
normally every 60 seconds and immediately on returning to the foreground. The
watcher uses the same request cache and follows any additional pages needed for
new activity, independent of search or how many pages the canvas has loaded.
Reusing cached results does not postpone the next background polling deadline.
The first successful baseline uses a response started after the current desktop
notification activation and remains silent, even if alerts are enabled during an
in-flight foreground refresh. If a baseline or continuation page is still cached
from an earlier check, the watcher waits for GitHub's polling interval before
revalidating it. OS settings control
the exact alert timing. Rate-limit backoff pauses upstream requests, but the
watcher can still process sufficiently fresh results already in its cache.

When the canvas is hidden, its visible-inbox polling pauses but desktop checks
continue about every minute after the last check. GitHub's
[`X-Poll-Interval` header](https://docs.github.com/en/rest/activity/notifications#about-github-notifications)
can require a longer wait, especially under high server load. Rate limits and
error retry waits still apply; error backoff starts at two minutes.
Closing all Notifications canvases in a session stops that session's watcher;
other sessions with open canvases can continue watching. For each repository:

- **1-4 new or updated unread threads** produce individual alerts with the
  repository name and notification title. Titles include the issue or PR number
  when available (for example, `#42 Fix login`).
- **5 or more in one poll** produce a single `<count> new notifications` summary
  with one sound request.

Counts reflect new activity, not the whole unread inbox. GitHub reports only
the latest activity per thread, not every event between polls.

The first successful poll after enabling or restarting all watchers is silent,
so existing unread items do not trigger alerts.

Sessions sharing a local `COPILOT_HOME` coordinate to avoid duplicate alerts;
separate machines or homes do not. A foreground check that finds another session
holding the desktop lock retries on the next five-second watcher tick, rather
than waiting for the next background polling deadline.
Delivery is **at most once**: failed or interrupted batches are not replayed,
so alerts can be lost. Reload older sessions after upgrades. Unsupported or
malformed checkpoints stop desktop watching with a coordination error; they
are never reset or migrated automatically. See [Troubleshooting](#troubleshooting)
for recovery.

Desktop alerts send repository names and titles to the OS, which may retain
them in notification history or show them on the lock screen.
See [Privacy](../README.md#privacy).

## Troubleshooting

- **No alerts or sound:** OS permissions, sound settings, and Focus/Do Not
  Disturb can suppress delivery, which the extension cannot confirm. Detected
  errors appear in Settings and the extension log.
- **Desktop coordination error after an upgrade:** preserve the artifacts and
  inspect the error before changing anything. If you explicitly choose to reset
  an unsupported or malformed `desktop-state.json`, first stop all extension
  processes sharing that `COPILOT_HOME`, then move only that file to a backup
  location. Leave settings and other artifacts intact. Reopen the canvas to
  establish a fresh silent baseline; activity received before that baseline
  will not produce alerts.
- **macOS helper error:** creation, compilation, signing or integrity failures
  stop delivery explicitly, without falling back to Script Editor. Preserve the
  affected `macos-notifier-*` entry and inspect permissions or modified files
  with all watchers stopped. Unrecognized or modified helpers are not replaced
  automatically. Failed alerts are not replayed.
- **Sender icon and clicks:** the OS controls the sender icon. New macOS alerts
  open Copilot, or the GitHub inbox when Copilot cannot be opened; they do not
  focus a particular canvas. Windows and Linux alerts do not have this click
  routing.
- **The canvas will not load:** see
  [installation troubleshooting](installation.md#upgrades-and-troubleshooting).
