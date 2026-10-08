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
