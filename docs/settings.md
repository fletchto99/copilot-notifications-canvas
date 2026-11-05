# Settings

[README](../README.md) | [Usage](usage.md) | [Installation](installation.md) | [Development](development.md)

Open **Settings** in the canvas to change these preferences. They are saved
across sessions and preserved during packaged upgrades.

| Setting | Default | Options and behavior |
| --- | --- | --- |
| Show notifications | All | **All** shows read and unread inbox items, excluding Done. **Unread only** shows unread items. Switching reloads the first page. No per-notification state is saved locally. |
| Group By | Repository | **Repository**: preserve GitHub's API order, grouping repositories by first appearance. **All notifications**: one collapsible group in API order. **Date**: newest local calendar day first, using REST update times for buckets and API order for rows. |
| Hide empty tabs | On | Hides attention tabs with zero loaded notifications. **All** and the selected tab always stay visible. Counts ignore search; tabs reappear when matching notifications are loaded. Saved choices are preserved. |
| Theme | Match Copilot | **Match Copilot** uses Copilot's theme colors, falling back to the OS theme when opened outside Copilot. **Dark** and **Light** use fixed palettes. |
| Auto-open | Off | Opens a missing Notifications panel when its provider attaches to a new or resumed session, unless you previously closed it in that session. Existing panels are left alone. |
| Desktop notifications | Off | Enables native alerts while a Notifications canvas is open and its extension process is running. |
| Sound | System default | System-specific sounds for desktop alerts; see the platform table below. |

With **Match Copilot** selected, the canvas inherits Copilot's theme colors and
typography, including custom palettes such as Fox, and follows theme changes
without a reload. This is the renamed
**System** option; existing saved choices are unchanged. Explicit
**Dark** and **Light** use the extension's fixed palettes, so their borders and
accents can differ from Copilot in the same color mode. Theme selection does not
change layout or spacing.

The saved grouping values remain `repo`, `none`, and `date`; the display labels
do not change existing preferences. Press Escape, click outside Settings, or move
keyboard focus outside it to close the panel.
Settings stays within the canvas viewport, scrolling internally when needed.
It opens above its button when that offers more space and closes if the button
scrolls out of view. Labels and dropdowns stack when needed to accommodate wider
text, and the panel adjusts when typography or header content changes.

The dropdown stores `matchGitHubInbox` in the user-wide settings file:
`true` means **All** and `false` means **Unread only**. Existing
choices are preserved without migration. Other open panels apply changes on
their next poll, without interrupting an active batch.
If settings become unreadable or invalid, an open inbox keeps its last applied
view and displays a settings warning rather than stopping refreshes or pagination.
The settings file is not reset or rewritten; repair it to restore preference
changes. A panel that has not read valid settings uses the default view with
the same warning. API-target validation at provider startup remains unchanged.
Desktop alerts still poll unread notifications only; this setting does not change
their baseline, enable alerts, or replay read or completed activity.

Auto-open is a user-wide preference, but dismissal belongs to each session.
Closing Notifications in one conversation does not affect other conversations.
Copilot's recorded canvas-close events preserve that dismissal across provider
reloads and session resumes. A missing panel with no recorded dismissal can open
again, even if the session has earlier conversation activity or Copilot internally
restarts it during setup. Existing panels are never focused by auto-open.
Renaming the startup panel ID preserves existing panels and recorded dismissals;
no settings or desktop-alert checkpoints need migration.

This is not a continuous keep-open loop. Changing the setting does not open
panels in other running sessions; it applies when a provider next attaches.
Temporary opening failures and same-session lock contention allow three attempts,
with retries after one and two seconds. Closing or manually opening Notifications,
starting new conversation activity, or shutting down cancels deferred attempts.
Exhausted attempts can try again on a later attachment; errors do not permanently
suppress auto-open. If both project and user providers are registered, a
per-session lock prevents duplicate opens and the project provider is preferred
when available.

Older `files/github-notifications-startup.json` checked markers are no longer
consulted or written. They are left untouched; recorded canvas dismissal, not a
previous disabled or failed startup check, determines whether to stay closed.

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
Windows alerts use the existing Windows PowerShell sender, including its
path-based Start menu registration; they do not register a new sender or use
PowerShell 7 or ISE.

Clicking a Windows alert opens its GitHub destination in your default browser:
the issue or pull request, or the resolved workflow run (the sole failed job's
logs when available). Check notifications use the same conservative run matching
as the canvas and fall back to filtered repository Actions when possible, or
the repository Actions page otherwise. Missing or unsupported item links open
the GitHub inbox. Repository burst summaries open the inbox filtered to that
repository. Links are limited to HTTPS github.com URLs and passed to Windows as
data, not commands; no browser is opened until you click. Existing alerts are
unchanged. macOS and Linux click behavior is unchanged.

### Polling and delivery

Desktop alerts poll the unread-only feed, normally every 60 seconds. With
**All** selected, the canvas uses a separate cache entry and cannot supply
a desktop baseline or include read/completed items in alert scans. Selecting
**Unread only**, or explicitly selecting the agent's unread view, lets the canvas
share unread results with the watcher.
The watcher follows every unread page before checkpointing activity,
independent of search or how many pages the canvas has loaded. An older REST
update timestamp does not stop the scan because those timestamps do not define
GitHub's inbox order. Large unread inboxes can therefore require more requests;
cache reuse, polling intervals, and rate-limit waits still apply. A failed
continuation leaves the activity checkpoint unchanged and sends no partial alerts.
Reusing cached results does not postpone the next background polling deadline.
The first successful baseline uses a response started after the current desktop
notification activation and remains silent, even if alerts are enabled during an
in-flight foreground refresh. Later-page backlog can extend the baseline up to
the first response's API `Date`, but activity newer than that snapshot remains
eligible for the next poll. When later pages have newer timestamps than the first
page, a missing or invalid first-response `Date` prevents checkpointing rather
than guessing from the local clock or a later response. If a baseline or
continuation page is still cached from an earlier check, the watcher waits for
GitHub's polling interval before
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
Windows alerts also include the GitHub destination URL; it is not saved in the
extension's coordination state or logs. Resolving individual Windows check
links may fetch workflow-run and job metadata, respecting the shared cache and
rate limits; it does not fetch log contents or resolve links for burst summaries.
Server retry/rate-limit deadlines from lookups are saved in the shared
checkpoint, including when a lookup is interrupted. Enabled, supported watchers
and their foreground refreshes inherit those deadlines; ordinary network,
permission, and read/done failure delays stay local to the failing client.
A watcher can still deliver from a sufficiently fresh cached page. A check
deferred before reading any page leaves the polling reservation unchanged,
without reporting a new poll error or extending the server's deadline.
That watcher also remembers the deferral locally, so background ticks do not
repeatedly reserve and restore the same checkpoint while it waits. Foreground
cache reuse remains available. Panel and agent refresh, load-more, and filter
actions inherit shared deadlines before fetching; a longer inherited rate-limit
wait replaces stale local error messages, but a longer local failure retains
its own message.
See [Privacy](../README.md#privacy).

## Troubleshooting

- **No alerts or sound:** OS permissions, sound settings, and Focus/Do Not
  Disturb can suppress delivery, which the extension cannot confirm. Detected
  errors appear in Settings and the extension log.
- **Windows alerts:** turn on the system-wide **Notifications** switch in
  **Settings > System > Notifications** (Windows 10: **Notifications & actions**).
  Also allow **Windows PowerShell** if it appears in the sender list; these
  alerts do not use Copilot's notification permission. The sender may not appear
  until its first alert; a missing per-sender settings profile does not block
  that first attempt. Windows reports
  `DisabledForUser` when notifications are disabled for the whole account, even
  if the PowerShell sender is registered. The extension does not change Windows
  settings. After correcting a delivery problem, only new activity can alert;
  failed alerts are not replayed.
  Detected PowerShell failures include a fixed stage (sender lookup, toast setup,
  permission check, or toast delivery) and a numeric HRESULT when available.
  These diagnostics exclude notification content and raw subprocess errors.
- **Desktop coordination error after an upgrade:** preserve the artifacts and
  inspect the error before changing anything. If you explicitly choose to reset
  an unsupported or malformed `desktop-state.json`, first stop all extension
  processes sharing that `COPILOT_HOME`, then move only that file to a backup
  location. Leave settings and other artifacts intact. Reopen the canvas to
  establish a fresh silent baseline; activity received before that baseline
  will not produce alerts.
- **Sender icon and clicks:** the OS controls the sender icon; clicking an alert
  cannot focus the canvas. Windows alerts open their GitHub destination in the
  default browser instead. Visiting GitHub may mark the notification read there;
  the extension does not send a read/done update when an alert is clicked.
- **The canvas will not load:** see
  [installation troubleshooting](installation.md#upgrades-and-troubleshooting).
