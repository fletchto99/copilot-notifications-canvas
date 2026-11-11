# Usage

[README](../README.md) | [Copilot](copilot.md) | [Installation](installation.md) | [Settings](settings.md) | [Development](development.md)

**Jump to:** [Find](#find-notifications) | [Status icons](#status-icons) |
[Views](#choose-a-view) | [Read / Done](#mark-read-or-done) | [Copilot](#work-with-copilot) |
[Refresh](#refresh-and-recover) | [Keyboard](#keyboard-and-preferences)

The canvas loads GitHub's read and unread inbox items, excluding Done.
Choose **Filters > Read state > Unread** or **Read** to narrow the view, or
**Read and unread** to show both. Read state applies even when the **All**
attention tab is selected. Pages contain up to 50
items, which can include both read and unread notifications.
**Search, counts, and bulk actions cover loaded items only.** Use **Load more**
to include older notifications.

## Work with Copilot

Use the Copilot button before Read to investigate, review, or summarize the
selected item. Its tooltip describes the task. New sessions summarize first
and remain read-only until you approve changes; Read/Done stays unchanged.
Existing sessions are opened without new instructions or interruptions.

The [Copilot actions guide](copilot.md) explains
[each notification type's prompt](copilot.md#actions-by-notification-type),
[confirmation and session-reuse rules](copilot.md#confirmations-and-existing-sessions),
and [exact-commit preparation](copilot.md#exact-commit-preparation).

## Find notifications

Search by **title, issue/PR number, or repository**, then combine it with an
attention tab and the **Filters** popover beside search. The toolbar opens
GitHub's inbox, refreshes, or opens Settings.

| Filter | Options |
| --- | --- |
| Read state | Read and unread, unread, or read |
| Type | Issues, pull requests, discussions, checks, releases, commits, vulnerability alerts, Dependabot alerts, security advisories, repository invitations, workflow runs, agent sessions, or other types |
| Reason | One exact GitHub notification reason, including review requested, mention, team mention, subscribed, or CI activity; unrecognized reasons appear under Other reasons |
| Age | Any time, past 24 hours / 7 days / 30 days, or older than 7 / 30 days |

All selected filters must match, along with search and the attention tab.
The button shows the number of active filters; open the popover to see their values.
Active dropdowns use the same blue border as the Filters button. Returning a
dropdown to its unfiltered default restores the normal border.
**Clear filters** clears these four controls across canvases, keeping each
canvas's search and attention tab unchanged. It is dimmed when none of the four
dropdown filters are active. Dropdown edits save automatically
and other visible canvases pick them up on their next local poll, normally within
five seconds. Hidden canvases catch up when visible again. These preferences are
shared by canvases using the same user settings directory, not across machines.
Changing filters never marks items read or done.

There is no separate Save action. Each edit merges only the changed dropdowns
into the current shared choices; editing Age in one canvas does not overwrite
a Type change in another. The last successful save wins when the same dropdown
is changed in two canvases. A failed or interrupted shared save is reported and
is not replayed automatically: check the shown selection and choose again to retry.
Sync progress is announced to screen readers without resizing the menu; failures
remain visible.
Each canvas retains its own loaded pages, so matching rows and counts can differ.
Running batches keep their original targets. If another canvas changes filters
before a new batch or retry starts, review the updated selection rather than
acting on a stale count.

Age uses GitHub's notification `updated_at`, not creation time or unread time,
in rolling 24-hour days rather than calendar dates. The exact cutoff is included
in **Past** and excluded from **Older than**. Matches update as time passes.
Unknown types and reasons remain available under **All** and **Other**; no
issue/PR status lookup is needed for these filters.

Read state only narrows loaded items: switching it never refetches or resets
pagination. A mixed page may contain fewer unread items than the old unread-only
API view; use **Load more** to find older unread matches. Empty filtered results
mean **No matches in loaded notifications**, not that the whole inbox is clear.
When no shared filters have been saved, an existing unread-only preference
initializes a new panel to **Unread**; otherwise it starts with **Read and unread**.
Saved shared filters take precedence over that legacy preference. Explicit
opening filters can override the initial view without saving, but the next
shared-settings update replaces those dropdown overrides. Search and attention
are always local. Changes never rewrite the legacy preference or affect desktop alerts.

Escape closes Filters and returns focus to its button; outside clicks or focus
also dismiss it. An open native select picker closes before its containing panel.

| Tab | Includes |
| --- | --- |
| All | Every loaded notification in the current view; selected by default |
| Mine | Issues, PRs, and discussions confirmed as authored by your signed-in account |
| Assigned | Assignments |
| Participating | GitHub's participation reasons, including assignments, mentions, and review requests |
| Mentioned | Personal mentions |
| Team Mentioned | Mentions of your teams |
| Review Requested | Requests for your review |

Except for Mine, tabs reflect GitHub's current reason, not your full participation history, and
can overlap. Participating includes comments, authorship, mentions, assignments,
manual subscriptions, state changes, invitations, review requests, and security
advisory credit.

Tab counts reflect the four popover filters but ignore text search and the selected
tab; the status line combines all filters, the selected tab, and search.
Refresh, Load more, and clearing search preserve the tab. **Hide empty tabs**
defaults on, but **All** and the selected tab remain visible. Text search does not
change tab visibility; popover filters can change the counts
and therefore which empty tabs are hidden.

Mine checks the item's actual author rather than the notification reason, which
can change after a mention or other activity. It covers loaded notifications,
not every item you have authored on GitHub. Authored rows show italic *mine*
after GitHub's reason and before the timestamp. Read rows can also be Mine.

Authorship loads in the background for all loaded issues, PRs, and discussions,
including filtered rows and collapsed groups. A `+` after the Mine count means
some authorship is pending or unavailable; the tab stays visible and explains
the incomplete count when selected. Unknown items are not treated as unowned
or included in Mine's bulk actions. New results update the count and selection;
bulk actions still require the current selection and retries keep their original
targets.

Counters show **N loaded · M unread**, never an estimate of the entire inbox.
Before the first successful load, counts are omitted rather than shown as zero.
A failed refresh keeps the last loaded counts and marks the view as stale.
Read rows have no unread dot and use lighter-weight titles. Each row shows its
type/number, reason, update time, and
repository when absent from the group heading. Navigation hints are available
to screen readers, never added to visible metadata.

Click the title, metadata, or space outside the action column to open GitHub;
native keyboard and modified-click behavior works. Opening a link sends no
read/done request from the extension, though GitHub may mark it read on arrival.
Read/Done actions and retries wait while search results catch up, so they cannot
act on an old selection. Input-method composition finishes before search applies.

GitHub owns completion state; the canvas stores no local completion history.
Agent inputs should use `readState: "all"`, `"read"`, or `"unread"`. For
compatibility, `mode: "unread"` selects the unread filter and `mode: "inbox"`
selects read and unread. An explicit `readState` takes precedence over `mode`.
Neither alias changes the fetched inbox or locks the controls. Explicit
`set_filters` actions sync dropdown changes across canvases just like the controls;
search and attention inputs remain local.

### Status icons

These describe the issue, PR, discussion, or check, **not Read/Done state**.
Icons distinguish states by shape as well as color; screen-reader descriptions
provide status, freshness, and failures without extra visible text or hover tooltips.
Notification and toolbar artwork uses [Primer Octicons](https://primer.style/octicons/),
bundled locally with the extension.

| Subject | States |
| --- | --- |
| Issue / PR | Green open; purple completed issue or merged PR; red closed unmerged PR; gray draft PR; gray slashed circle for not-planned or duplicate issues; yellow dotted merge icon for queued PRs |
| Discussion | Purple overlapping checkmarked bubbles for resolved; green circled checkmark for answered; gray open/reopened, slashed duplicate, or clock-marked outdated |
| Check suite | Green passing checkmark, red failure/timeout/startup-failure cross, amber pending clock; distinct descriptions for other outcomes |
| Release / Commit | Static tag / commit icon |
| Security advisory or vulnerability / Dependabot alert | Static shield |
| Repository invitation / WorkflowRun / AgentSessionThread | Static envelope / workflow / robot |
| Unknown type | Bell with the original type label, or **Notification** for an empty label |

Release links open the repository's releases page. Unknown or unavailable state
never hides a notification or guesses that it is closed.

### Loading and freshness

Status loads in the background for loaded search/tab matches in expanded groups,
including rows below the viewport. Authorship checks reuse issue, PR, and
discussion detail requests, so those statuses also warm for filtered and
collapsed rows. Merge queue and check-suite lookups wait until their rows are
shown in expanded groups.
Up to twenty lookups run across panels sharing the provider; results are shared
and cached in memory for five minutes, or longer if GitHub requires it.
Desktop polling does not fetch these details.

Initial lookups show a spinner (stationary with reduced motion); refreshes keep
known icons. **Force refresh** and changed notifications revalidate sooner without
bypassing limits or backoff. Screen readers announce **Checked N minutes ago**;
failed refreshes preserve the last status and check time as a **cached result**.
Unavailable states explain access, SSO, or other errors. Status-loading failures
retry automatically without disabling inbox actions or hiding usable rows.

Issue/PR/check status uses read-only REST; discussions and PR merge queues use
GraphQL. Issue/PR authorship compares REST author IDs with the signed-in account
from `/user`; discussion checks include `viewerDidAuthor`, not titles, bodies,
or comments. IDs stay in provider memory, never in the renderer or agent results.
Custom development REST APIs do not query github.com for GraphQL details.
Queue failures preserve known REST state. A primary GraphQL quota limit pauses
those checks, not REST polling or Read/Done; authentication and secondary limits
still affect shared requests.

The visible panel polls its local provider every second during lookups, otherwise
every five seconds, and stops when hidden. This does not increase GitHub polling.

### Check-run destinations

Validated run URLs and suites resolving to exactly one Actions run open that
run. When links are missing, recognized workflow titles can supply the
**reported notification result**, which may differ from a later rerun; unknown
formats remain unknown. Suite IDs are never treated as run IDs.

Recognized titles ending in `for <branch> branch` may also yield a best-effort
run link. A match must uniquely agree on workflow, branch, result, and attempt
(1 unless specified), with an update within two minutes of the notification.
Conflicting nearby runs rule it out. Searches require a complete set of at most
100 runs created from seven days before through two minutes after the notification;
the canvas never simply picks the latest or nearest run.

Inferred links open the matched attempt and explain the uncertainty to screen
readers; they do not turn reported icons into live status. Failed revalidation
removes the inferred link. Ambiguous, inaccessible, or unsafe matches fall back
to Actions filtered by workflow/branch/outcome when safe, otherwise the repository
Actions page. Later reruns can change the results of an outcome filter.

A resolved failed run opens job logs only when exactly one job failed, timed out,
or failed at startup. Job lookups use the resolved attempt when available;
only run responses without an attempt fall back to GitHub's latest-job lookup.
Unfinished, incomplete (including over 100 jobs), inaccessible, unsafe,
or non-unique results keep the run summary. Only metadata is read, never logs;
screen-reader descriptions retain lookup errors and inferred-match caveats.

During initial run/job resolution, CI-row navigation waits while Read/Done remain
separate. It becomes available with a logs, run, or Actions destination even if
lookup fails. Refreshes preserve usable links/icons; changed notifications may
require resolving a new destination.

## Choose a view

Open **Settings > Group By**:

| View | Groups and bulk-action scope |
| --- | --- |
| All notifications | One group across repositories, preserving GitHub's API order |
| Repository | One group per repository in first-seen API order; preserve the API's row order within each group |
| Date | One group per browser-local calendar day, newest day first; API row order within each day |

Rows retain API order within each group, not repository-name or `updated_at`
sorting. Displayed times and date buckets use REST `updated_at` and
can differ from GitHub's website. Date grouping requires a supported browser
time zone; the other views do not.

Pagination keeps duplicate threads' first-seen positions with the newest data.
After confirmed writes, invalidated pages are revalidated before cache reuse;
old pages cannot restore stale read status. Rate/error backoff still applies.

Click a group header to collapse it, or use **Collapse all / Expand all**.
Header actions remain available while collapsed. On narrow panels, header
controls wrap while row actions stay beside their content.

## Mark read or done

| Action | Row control | Effect on GitHub |
| --- | --- | --- |
| Mark as read | Envelope | Mark read; keep in your inbox |
| Mark as done | Checkmark | Move to Done |

Read rows keep a dimmed, disabled envelope labeled **Already read**, alongside
Done. The disabled envelope is skipped by Tab navigation and sends no request
when clicked. Its **Already read** tooltip remains available on hover.
After a confirmed Read in **Read and unread**, the row stays and focus moves from Read to
Done; a second click on the disabled envelope cannot open the row.
A status update can unlock Done and move focus before the
Read acknowledgement arrives, without overriding focus moved elsewhere.
With the **Unread** filter, Read hides the row but retains it in the loaded inbox;
choosing **Read** or **Read and unread** shows it again.
Done removes it from the inbox regardless of the filter.

A pending row action locks only that row and group actions that include it.
Other rows remain actionable, including rows in the same group.
Row actions are acknowledged when queued, then progress and results arrive
through status updates. A long wait in the write queue does not report a failed
write. If the acknowledgement is lost, status updates recover the accepted
operation's actual result without sending the write again. Disconnection remains
explicit until its outcome can be checked; a row disappearing under a filter is
not proof of success.
Rows change only after confirmation; failures remain visible until an
explicit retry, a successful refresh, or a successful update to that notification
from a group action or another panel. Status updates preserve the next-row
keyboard focus target even if they arrive before the action acknowledgement.

### Act on a group

Headers have the same Read/Done buttons; hover or focus for **Mark N as read/done**.
They act directly, with no dropdown. Read targets unread matches; Done includes
read and unread. Read hides when none are eligible without moving or activating Done.

**Only that group's loaded tab/search/popover-filter matches are included**, even when collapsed.
Filtered-out and unloaded items are excluded; date actions cover just the selected
day. The group button and every targeted row show a busy spinner immediately,
including rows waiting for a shared request slot, without adding progress text
to the header or moving keyboard focus. Progress counts remain available in
action tooltips and screen-reader announcements. Spinners respect reduced motion.
**Queued** means a write is waiting its turn;
**Marking** means a request is in flight. Row action tooltips use the same
queued/active distinction. Accepted row and group actions immediately check
their dispatch status instead of waiting for the next progress poll.

Independent groups and rows can have actions in progress together. A group action
locks its selected rows, not the rest of the inbox; overlapping actions are
blocked across panels. Each batch has its own progress. Read and Done share a
limit of ten concurrent GitHub requests across panels in the same provider,
without an artificial delay between writes. Inbox page requests remain ordered
with writes, and GitHub's rate limits and retry waits still apply.
Search and attention tabs stay usable: they change the displayed rows, never an
active batch's captured targets. Refresh and notification-view changes wait until
active actions finish.

Group actions run through their selected notifications without a Stop control.
If a request fails, the batch stops sending new requests and waits for all
in-flight results. **Retry remaining** retries only the unfinished work when its
wait expires. Failure details and retry controls appear beside the group, or above
the list if filtering or regrouping hides that group. Closing the panel still
cancels outstanding work.

Retry conflicts consider only currently shown, unchanged, eligible targets, so
an unrelated write to a filtered-out item does not block the remaining retry.
Retry requests are bound to the displayed filters and eligible targets. If another
canvas changes that selection before the request arrives, no retry writes start;
review the refreshed selection and retry explicitly.
Retries keep the original action and scope, including the
date and time zone. They exclude successes, new arrivals, changed items, and
items that no longer match your filters.

## Refresh and recover

Loaded pages refresh about every 60 seconds while visible and pause while hidden.
Returning or choosing **Force refresh** checks immediately unless rate/error
backoff applies. The retry time is shown; refresh stays focusable but cannot send
requests during the wait. Hover or focus it for the last successful update time.

Completing the last notification shows **All caught up** immediately if no known
pages remain; automatic refresh continues. Otherwise, refresh before loading more.

| Message | Next step |
| --- | --- |
| Loaded notifications cleared | Known remaining pages exist; refresh after read/done changes, or load more if available |
| No matches in loaded notifications | Change the tab or search; load more if offered |
| All caught up | No loaded items or known remaining pages; automatic refresh keeps checking for new notifications |
| Request failed | Follow the error message; usable rows stay visible while automatic checks wait to retry |

## Keyboard and preferences

| Key / gesture | Effect |
| --- | --- |
| J / K | Focus the next / previous visible notification in the displayed order |
| Enter in search | Focus the first visible result once filtering finishes; does not open it |
| Enter on a row link | Open GitHub using the native link; no extension Read/Done request |
| I | Mark only the focused notification as read, then advance to the next visible row |
| Shift+E | Mark only the focused notification as done |
| / | Focus search without changing the query |
| ? or the question-mark toolbar icon (before Settings) | Open the keyboard shortcut guide |
| Left/Right Arrow, Home, End | Switch visible attention tabs; edge scroll buttons do not change selection |
| Tab | Visit row links and separate Read/Done controls; empty-state panels remain focusable |
| Hover / focus a button | Show its action tooltip |
| Escape | Close the shortcut guide and restore focus, or dismiss a tooltip or open menu; dismissal survives row updates |
| Click or focus outside Settings or Filters | Close that popover |
| Hold Enter | Does not repeat Read/Done/batch actions after focus moves; release and press again |

Character shortcuts are enabled by default and can be disabled in
**Settings > Keyboard shortcuts**. They work only while the canvas has focus,
not while typing in search, editing text, composing with an input method, or
using Settings, Filters, or the shortcut guide. Ctrl/Command/Alt combinations and native
Tab, arrow, and Enter behavior on links and buttons are left alone. Enter in
search also works with character shortcuts disabled. The toolbar help icon is hidden
when shortcuts are disabled; re-enable them in Settings to bring it back.
On panels 360px or narrower, the utility icons sit in a right-aligned row below
the title so font differences do not squeeze the title between controls.

Search Enter waits for pending filters and ignores input-method composition.
Editing the query again, moving focus away, or a failed filter cancels the
pending focus move. With no visible result (including collapsed groups), focus
stays in search. Holding Enter through the focus move cannot open the result;
release and press again to open its link.

J/K skip collapsed groups and stop at the first/last row without wrapping or
loading more. With no row focused, J starts at the first visible row and K at
the last. Read/Done shortcuts require focus on a row link or one of its buttons,
including Copilot. They never act on a group or a previously focused row.
Holding these keys does not repeat writes. Done requires Shift; pressing E alone
does nothing.
Pending filters, writes, and batches use the same safeguards
as the buttons.

After a successful Read shortcut, focus advances to the next visible row, even
when the read row remains in **All**. At the end of the list it stays on the
retained row without wrapping. Clicking Read still focuses that row's Done button.
When an action removes its row, focus moves to the next visible row (or the
previous row at the end); if none remain, focus moves to search. Failures retain
focus and show the existing action error; moving focus elsewhere while a request
runs is respected.

Background updates preserve controls and in-progress clicks without stealing
focus from Copilot's composer or another window. If notifications arrive while
the empty-state panel is focused, focus moves to the first group header.
Hover highlights clear on navigation or window blur and resume on fresh pointer input.

[Settings](settings.md) persists view, grouping, theme, keyboard shortcuts, auto-open, desktop alerts,
and sound across sessions. Auto-open and desktop alerts default **off**.
Opted-in alerts can continue while the canvas is hidden; see
[desktop notification privacy and support](settings.md#desktop-notifications).
