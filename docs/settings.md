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

Checks run about every two minutes, subject to GitHub limits and independent of
search or loaded pages. For each repository:

- **1-4 new or updated unread threads** produce individual alerts with the
  repository name and notification title.
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
