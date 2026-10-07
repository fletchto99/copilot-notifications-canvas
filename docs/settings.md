# Settings

[README](../README.md) | [Installation](installation.md) | [Development](development.md)

Open **Settings** in the canvas to change these preferences. They are saved
across sessions and preserved during packaged upgrades.

| Setting | Default | Options and behavior |
| --- | --- | --- |
| Group By | repo | **repo**: alphabetical repositories, newest items first. **none**: one newest-first list. **date**: newest local calendar day first. All use last-updated times. |
| Theme | System | **System** follows Copilot, falling back to the OS theme. **Dark** and **Light** override it. |
| Auto-open | Off | Opens once per new session, including general chats; not on resume, reload, or after closing the panel. |
| Desktop notifications | Off | Enables native alerts while a Notifications canvas is open and its extension process is running. |
| Sound | System default | System-specific sounds for desktop alerts; see the platform table below. |

## Desktop notifications

Enable **Desktop notifications** and choose a **Sound**. Alerts continue while
the panel is hidden or Copilot is minimized, provided its session's extension
process is running. Closing the last Notifications canvas or quitting Copilot
stops them. No extra software is installed automatically.

### Platform support

| Platform | Requirements | Sounds |
| --- | --- | --- |
| macOS | Built-in `osascript`; allow notifications for the script sender. | System default or named sounds such as Glass, Ping and Submarine. |
| Windows 10/11 | Built-in Windows PowerShell/WinRT, PowerShell's existing Start menu registration, and an interactive desktop. | Default, IM, Mail, Reminder and SMS. |
| Linux | `notify-send` (libnotify) and a graphical D-Bus notification service. | Default or themed sound hints; desktops may ignore sound or silence hints. |

Windows and Linux support is experimental. Alerts run on the **extension host**;
remote sessions do not automatically notify your local computer.

### Polling and delivery

While the canvas is visible, its checks feed the same results to desktop alerts,
normally every 60 seconds and immediately on returning to the foreground. The
watcher uses the same request cache and follows any additional pages needed for
new activity, independent of search or how many pages the canvas has loaded.
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
separate machines or homes do not. Delivery is **at most once**: failed or
interrupted batches are not replayed, so alerts can be lost. Reload older
sessions after upgrades; a changed checkpoint format starts a fresh silent baseline.

Desktop alerts send repository names and titles to the OS, which may retain
them in notification history or show them on the lock screen.
See [Privacy](../README.md#privacy).

## Troubleshooting

- **No alerts or sound:** OS permissions, sound settings, and Focus/Do Not
  Disturb can suppress delivery, which the extension cannot confirm. Detected
  errors appear in Settings and the extension log.
- **Sender icon and clicks:** the OS controls the sender icon; clicking an alert
  cannot focus the canvas.
- **The canvas will not load:** see
  [installation troubleshooting](installation.md#upgrades-and-troubleshooting).
