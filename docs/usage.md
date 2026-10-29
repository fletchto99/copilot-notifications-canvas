# Usage

[README](../README.md) | [Installation](installation.md) | [Settings](settings.md) | [Development](development.md)

The canvas shows unread GitHub notifications, loading up to 50 at a time.
**Search, counts, and bulk actions cover loaded items only.** Use **Load more**
to include older notifications.

## Find notifications

Search by title, issue/PR number, or repository. Each row shows its type, number
when available, notification reason, and last-updated time.

Combine search with an attention tab:

| Tab | Includes |
| --- | --- |
| All | Every loaded unread notification; selected by default |
| Review requested | Requests for your review |
| Mentioned | Personal and team mentions |
| Assigned | Assignments |
| Participating | Threads you authored or commented on |

Tabs use GitHub's current notification reason, not your full participation
history. Their counts ignore search; the status line shows matches for both the
selected tab and search. Refreshing, loading more, or clearing search keeps the
selected tab.

## Choose a view

Open **Settings > Group By**:

| View | Groups and bulk-action scope |
| --- | --- |
| All notifications | One newest-first group across repositories |
| Repository | One group per repository, sorted alphabetically; newest items first |
| Date | One group per browser-local calendar day, newest first, across repositories |

All views use last-updated times. Repository names appear in row metadata when
they are not already in the group header.

Click a group header to collapse it, or use **Collapse all / Expand all**.
Header actions remain available when collapsed. On narrow panels, header
controls wrap while row actions stay beside the content.

## Copilot triage

Choose the **Copilot** icon beside the inbox link, review the disclosure and
shown count, then choose **Allow and triage shown notifications**. Your
acknowledgment is remembered across sessions. Later clicks start triage directly,
without another warning or count confirmation. Only the acknowledgment version
is saved, not notification content.

The disclosure remains available under **Settings > Copilot data sharing**.
Choose **Show warning next time** to reset the acknowledgment across panels and
sessions. Resetting does not cancel an already-started run. If a future release
changes the data-sharing scope, its new disclosure requires acknowledgment.
Opening the canvas, refreshing, or enabling desktop alerts never starts AI
analysis; each run still requires an explicit click on Copilot.

Triage requires a current Copilot app/SDK, an installed **Copilot CLI**, and a
GitHub account with Copilot access. The CLI must be available on the app's
`PATH`, or `COPILOT_CLI_PATH` must point to its absolute executable or JavaScript
entry file. On Windows, use `copilot.exe` or set that variable to the CLI's
JavaScript entry file, not a `.cmd` wrapper. Restart the app after changing its
environment. The extension never installs a CLI or extracts a GitHub token.

The separate AI session starts without the current conversation or repository
instructions. It has only two read-only tools: list the approved shown
notification snapshot and read a selected notification's issue/PR context.
It cannot access arbitrary URLs, repositories, unloaded notifications, shell
commands, files, other agents, or GitHub write operations.

- Scope is the loaded attention/search matches when you start a run, including
  collapsed groups. It is not the entire GitHub inbox.
- Copilot requests notification metadata through its tool; the initial prompt
  contains no notification content. Header reads reuse the provider's GitHub
  snapshot instead of fetching the inbox again.
- Copilot decides which issue/PR context to fetch. Context includes up to 6,000
  body characters and the last page of up to 10 issue comments, each limited
  to 1,500 characters. Notification/subject titles are limited to 512 characters.
  PR diffs, review threads, linked resources, and other subject types are not
  fetched. Recommendations identify notification-only versus thread-backed
  evidence; these bounds can omit important context.
- Suggestions appear below each notification: **Needs attention**, **For
  awareness**, **Possibly dismissible**, or **Insufficient context**.
  They are advice, not a guarantee that dismissing anything is safe. The
  existing read/done controls remain manual.
- Changing the shown selection or its content invalidates the results and
  stops further tool reads. **Cancel triage** stops the separate session;
  closing the canvas also cancels it. Hiding the canvas does not cancel it.
- Runs use your Copilot allowance, have a five-minute deadline and a bounded
  tool-call budget, and never retry automatically. If a run is incomplete,
  fails, or times out, narrow the view and explicitly start a new run.

See [Privacy](../README.md#privacy) before enabling a run. Temporary session
directories are named `notifications-triage-*` under the operating system's
temporary directory. A crash may leave these directories behind; stop the
owning app/CLI before manually removing a leftover directory. Dismissing
recommendations does not undo processing or retention by the AI service.

## Mark read or done

| Action | Row control | Effect on GitHub |
| --- | --- | --- |
| Mark as read | Envelope | Mark read; keep in your inbox |
| Mark as done | Checkmark | Move to Done |

Both actions remove the row from this unread-only canvas after GitHub confirms
success. The canvas keeps no local completion history. Use the toolbar's inbox
icon to open [GitHub's inbox](https://github.com/notifications) and view read or
done notifications.

### Act on a group

Choose **Mark N as read** in its header, or open the adjacent dropdown for
**Mark N as done**. Read stays the default.

The action includes only that group's loaded attention/search matches, even
when collapsed. It never includes filtered-out or unloaded notifications.
Date actions cover only the selected day, not the entire date view.

- **Stop remaining** lets an in-flight request finish, then stops.
- **Continue remaining** resumes a stopped batch.
- **Retry remaining** retries a failed batch when its wait expires.

Continuations and retries keep the original action and scope, including the
date and time zone. They exclude successes, new arrivals, changed items, and
items that no longer match your filters.

## Refresh and recover

The canvas checks loaded pages about every 60 seconds while visible and pauses
while hidden. Returning to it or choosing **Force refresh** checks immediately,
unless GitHub requires a rate-limit or error wait. The retry time is shown;
refresh controls remain focusable but cannot send requests during that wait.
Hover or focus the refresh icon to see when the last update succeeded.

| Message | Next step |
| --- | --- |
| Loaded notifications cleared | Refresh to check for remaining unread items, or load more if available |
| No matches in loaded notifications | Change the tab or search; load more if offered |
| All caught up | No loaded unread items, known remaining pages, or pending reconciliation remain |
| Request failed | Follow the error message; usable rows stay visible while automatic checks wait to retry |

## Keyboard and preferences

- **Left/Right Arrow**, **Home**, or **End** switches attention tabs.
  The strip's edge buttons scroll without changing your selection.
- **Tab** moves through controls, including each row's title, Read, and Done.
- Hover or focus a row action for its **Mark as read** or **Mark as done** tooltip.
- **Escape** dismisses a tooltip or open menu. Settings also closes when you
  click or move focus outside it.

[Settings](settings.md) saves grouping, theme, auto-open, desktop alerts, and
sound across sessions. Auto-open and desktop alerts default to off. Opted-in
desktop alerts can continue while the canvas is hidden; see
[desktop notifications](settings.md#desktop-notifications) for platform support
and privacy details.
