# Usage

[README](../README.md) | [Installation](installation.md) | [Settings](settings.md) | [Development](development.md)

The canvas mirrors GitHub's inbox by default: read and unread notifications are
shown. Choose **Settings > Show notifications > Unread only** to narrow the view. Done
notifications are excluded in both views. It loads up to 50 at a time.
**Search, counts, and bulk actions cover loaded items only.** Use **Load more**
to include older notifications.

## Find notifications

Search by title, issue/PR number, or repository. Each row shows its type, number
when available, notification reason, and last-updated time.
Click the title, metadata, or empty space outside the action column to open the
row's GitHub destination.
Rows use native links, including keyboard and modified-click behavior, without
underlining their titles. Read and Done remain separate controls; opening a row
does not send a read/done request from the extension.
Read/Done actions and batch retries remain unavailable while a search change is
pending, so they cannot act on the previous selection. You can keep editing the
search; actions become available once the displayed results catch up.

Combine search with an attention tab:

| Tab | Includes |
| --- | --- |
| All | Every loaded notification in the current view; selected by default |
| Assigned | Assignments |
| Participating | GitHub's participation reasons, including assignments, mentions, and review requests |
| Mentioned | Personal mentions |
| Team Mentioned | Mentions of your teams |
| Review Requested | Requests for your review |

Tabs use GitHub's current notification reason, not your full participation
history. Participating includes `comment`, `mention`, `author`, `team_mention`,
`assign`, `manual`, `state_change`, `invitation`, `review_requested`, and
`security_advisory_credit`. Tabs can overlap; Participating is not limited to
comments and authorship. Their counts ignore search; the status line shows matches
for both the selected tab and search. Refreshing, loading more, or clearing search
keeps the selected tab.
Read rows have no unread dot and use lighter-weight titles with a tone between
the foreground and muted metadata colors. Group badges and the overall counter
consistently show **N total · M unread**, even when all items are unread or none
are unread. Totals still cover loaded items only.

**Settings > Show notifications** defaults to **All**. Switching this setting reloads
the first page, retaining search and attention filters. A failed reload keeps the
previous view and reports an error. The canvas does not infer or store completion
history.
The agent-facing `mode: "unread"` filter remains supported for existing callers.
In that view, the dropdown displays **Unread only** and is unavailable; switching
back to `mode: "inbox"` restores the saved preference.
Changing the saved view elsewhere does not reset pagination in an explicitly
selected unread view.

## Choose a view

Open **Settings > Group By**:

| View | Groups and bulk-action scope |
| --- | --- |
| All notifications | One group across repositories, preserving GitHub's API order |
| Repository | One group per repository in first-seen API order; preserve the API's row order within each group |
| Date | One group per browser-local calendar day, newest day first; API row order within each day |

Repository names appear in row metadata when they are not already in the group
header. Repository grouping preserves the API's order rather than sorting by
name or the REST `updated_at` field: that field can differ from the timestamp
GitHub uses to order the inbox. This applies in both inbox and unread-only views.
Search and attention filters retain the relative order of matching items.
Pagination keeps the first-seen position of duplicate threads while using data
from the newest response. Older cached pages cannot restore stale read status,
even when the notification's update timestamp has not changed.
Pages invalidated by a confirmed Read/Done write are revalidated before cache
reuse, so returning to a view cannot skip notifications at page boundaries.
Rate-limit and error backoff still apply.

Displayed relative times and date buckets still use REST `updated_at`, so they
can differ from GitHub's website. **All notifications** preserves the original
cross-repository API order. **Date** orders calendar headings newest-first while
preserving API order inside each day. Switching grouping does not reorder rows
by their REST update timestamps.

Click a group header to collapse it, or use **Collapse all / Expand all**.
Group headers have a subtle, theme-aware background that stays unchanged on
hover. Their action buttons retain hover and keyboard-focus feedback.
Header actions remain available when collapsed. On narrow panels, header
controls wrap while row actions stay beside the content.
Spacing is compact to fit more notifications without reducing text or action-button sizes.

## Mark read or done

| Action | Row control | Effect on GitHub |
| --- | --- | --- |
| Mark as read | Envelope | Mark read; keep in your inbox |
| Mark as done | Checkmark | Move to Done |

Already-read rows show only Done, not a disabled Read action. After GitHub confirms
a read, the row stays visible and keyboard focus moves to Done when
**All** is selected. With **Unread only** selected, the read row leaves the view.
In **All**, Read disappears but its space stays reserved, preventing a second
click there from opening the row.
Done always removes the row.
The toolbar's inbox icon opens [GitHub's inbox](https://github.com/notifications).

### Act on a group

Each header has an envelope for **Read** and a checkmark for **Done**, matching
the row controls. Hover or focus a button to see **Mark N as read** or **Mark N
as done** with its eligible count. Both act directly on the counted selection;
there is no dropdown. Done stays on the right, and Read never changes into Done.

The action includes only that group's loaded attention/search matches, even
when collapsed. It never includes filtered-out or unloaded notifications.
Date actions cover only the selected day, not the entire date view.
Read includes only unread matches; Done includes both read and unread matches.
Each control's tooltip gives its eligible count. Read is hidden when that count is
zero, without moving or automatically activating Done. An active batch shows
progress with a spinner on its chosen action and counts in its tooltip.

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
| Loaded notifications cleared | Refresh to check for remaining items, or load more if available |
| No matches in loaded notifications | Change the tab or search; load more if offered |
| All caught up | No loaded items, known remaining pages, or pending reconciliation remain |
| Request failed | Follow the error message; usable rows stay visible while automatic checks wait to retry |

## Keyboard and preferences

- **Left/Right Arrow**, **Home**, or **End** switches attention tabs.
  The strip's edge buttons scroll without changing your selection.
- **Tab** moves through controls, including each row link and Done, plus Read
  for unread rows.
  Populated inboxes skip the surrounding tab panel; empty states keep that panel
  focusable so their message remains reachable. If rows arrive while that panel
  is focused, focus moves to the first group header. Focus elsewhere is left alone.
- Hover or focus a row action for its **Mark as read** or **Mark as done** tooltip.
- Tooltips appear above controls, or below when there is not enough room at the
  top of the canvas.
- **Escape** dismisses a tooltip or open menu. Settings also closes when you
  click or move focus outside it. Opening or closing Settings with its button
  dismisses its tooltip until the next hover or keyboard focus.

[Settings](settings.md) saves the notification view, grouping, theme, auto-open, desktop alerts, and
sound across sessions. Auto-open and desktop alerts default to off. Opted-in
desktop alerts can continue while the canvas is hidden; see
[desktop notifications](settings.md#desktop-notifications) for platform support
and privacy details.
