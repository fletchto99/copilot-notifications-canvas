# Usage

[README](../README.md) | [Installation](installation.md) | [Settings](settings.md) | [Development](development.md)

The canvas mirrors GitHub's inbox by default: read and unread notifications are
shown. Choose **Settings > Show notifications > Unread only** to narrow the view. Done
notifications are excluded in both views. It loads up to 50 at a time.
**Search, counts, and bulk actions cover loaded items only.** Use **Load more**
to include older notifications.

## Find notifications

The compact title row keeps **Open GitHub inbox**, **Force refresh**, and
**Settings** together. Full-width search and attention tabs stay visible below
it, followed by loaded counts and **Collapse all**. The title wraps on narrow
panels without shrinking the utility buttons.

Search by title, issue/PR number, or repository. Each row shows its type, number
when available, notification reason, and last-updated time.
The repository is also shown when it is not already in the group heading.
Visible row metadata never includes custom destination hints such as
**Open repository releases** or **Open GitHub inbox**. Fallback destinations
remain available to screen readers without adding visible metadata.
Date grouping requires a supported browser time zone; the other groupings do not.
Issues and pull requests also have state-aware icons: open
items are green, completed issues and merged pull requests are purple, closed
unmerged pull requests are red, and draft pull requests and issues closed as
not planned are gray. A yellow dotted merge icon identifies PRs in the merge
queue. Icons have no hover tooltips or extra status text in the row; their
state descriptions remain available to screen readers. Live descriptions include
the time of the last successful check, such as **Checked 2 minutes ago**.
The age advances locally without extra GitHub requests. A failed refresh keeps
the last known icon and identifies it as a **cached result** with the failure
reason; it does not pretend the old result was just rechecked.
These are subject states, not the notification's Read/Done state.

Discussions also have state-aware icons. Resolved discussions use a purple
checkmarked discussion bubble; answered discussions use green bubbles.
Open or reopened discussions stay gray. Duplicate and outdated discussions use
gray bubbles with a slash or clock, respectively. Discussion state comes from
a read-only GraphQL query for `closed`, `isAnswered`, and `stateReason`;
it never fetches discussion titles, bodies, or comments. Missing links, denied
access, or custom development REST APIs leave the icon gray with an explicit
status-unavailable description rather than guessing that a discussion is closed.

Other notification types have static icons, with no status lookup or loading
indicator:

| Subject type | Icon |
| --- | --- |
| `Release` | Tag |
| `Commit` | Commit |
| `RepositoryAdvisory`, `RepositoryVulnerabilityAlert`, `RepositoryDependabotAlertsThread` | Security shield |
| `RepositoryInvitation` | Envelope |
| `WorkflowRun` | Workflow |
| `AgentSessionThread` | Robot |
| Any other type | Bell |

Unknown types keep their type label; an empty or whitespace-only label appears as
**Notification**. Release links still open the repository's releases page.

GitHub's [notifications REST API documentation](https://docs.github.com/en/rest/activity/notifications)
lists notification **reasons**, not an exhaustive set of subject types. Its
[official OpenAPI schema](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json)
defines `subject.type` as a string without an enum. The named static icons cover
known types also handled by [Gitify](https://github.com/gitify-app/gitify/blob/main/src/renderer/utils/forges/github/handlers/index.ts);
the bell fallback allows new types without assuming that this list is complete.

Check suites use a green checkmark for passing, a red cross for failure,
timeout or startup failure, and an amber clock for pending work. Cancelled,
skipped, neutral, stale, and action-required results retain distinct descriptions.
When GitHub supplies a validated check-suite API link, the status comes from
that suite. GitHub sometimes omits this link; in that case, recognized
`workflow run succeeded/failed/... for ...` titles supply the **reported
notification result**, not the current result of a later rerun. The icon's
screen-reader description makes that distinction explicit. Unknown
title formats remain unknown, and suite IDs are never treated as workflow run IDs.
Rows link directly to workflow run results when GitHub supplies a validated run
URL or the suite ID resolves to exactly one matching Actions run.
For missing IDs, recognized titles ending in `for <branch> branch` can also
identify an inferred run. Matching requires the same workflow name, branch,
reported result, and attempt (attempt 1 unless the title explicitly names
another). There must be exactly one nearby run of that workflow and branch,
updated within two minutes of the notification. A conflicting nearby run rules
out a match even if its result or attempt differs. The search covers runs created
in the preceding seven days through two minutes after the notification, requires
a complete result set of at most 100 runs, and never chooses the latest or
nearest run merely because it exists. Inferred links open that specific attempt.
They remain best-effort associations, not an authoritative notification-to-run
mapping, and do not change the reported status icon into a live run status.

Ambiguous, missing, inaccessible, or unsafe results fall back to Actions filtered
by workflow, branch, and reported outcome when the title can be parsed safely,
or the repository Actions page otherwise. A later rerun can change which runs
appear under an outcome filter. The destination remains available to screen
readers without a repeated **Open repository Actions** label in the metadata.
Inferred links explain the best-effort match in their screen-reader descriptions,
without an extra visible metadata label or icon tooltip.
Failed matching refreshes remove the inferred link rather than
retaining an unverified destination.

For failed workflow notifications with a resolved run, the row opens the job log
viewer if exactly one job failed (including a timeout or startup failure).
Inferred runs use the matched attempt's jobs; direct run and suite links use
the latest execution's jobs. Zero or multiple failed jobs, unfinished jobs,
incomplete lists (including runs with more than 100 jobs), inaccessible details,
or unsafe job links keep the run summary instead. Job lookup errors appear in
the icon's screen-reader description. Screen-reader descriptions retain the
matching caveat when opening an inferred run's job. The extension reads only job metadata, never
downloads logs, and does not choose an arbitrary failed job.

Status loads in the background through additional GitHub CLI REST requests,
only for loaded items with validated issue, PR or check-suite links. Recognized
unlinked workflow notifications also use bounded read-only Actions searches.
Resolved failed runs use an additional bounded job-metadata request to find
a unique log-viewer destination.
Open PRs
also use a read-only GraphQL query for merge queue membership. Queue access
failures preserve the known REST state and add an explanatory screen-reader
description; custom development REST APIs do not query github.com for queue data.
Discussion lookups use the same GraphQL quota and do not run against custom
development REST APIs.
Exhausting GraphQL's primary quota pauses discussion and merge-queue checks without blocking
REST inbox polling or Read/Done actions. Authentication failures and secondary
rate limits still pause shared requests.
Lookups are shared across
panels in the provider and cached in memory for five minutes (or longer if
GitHub requests it). Changed notification timestamps and **Force refresh**
revalidate status sooner, without bypassing rate limits or failure backoff.
Uncached lookups cover all loaded rows in expanded groups, scheduled from top to bottom in the current
repository, flat, or browser-local date grouping. Search and attention filters
exclude hidden matches from this work. Rows outside the viewport load without
waiting for scrolling; collapsed groups wait until expanded. Expanding or
collapsing a group updates this transient selection without persisting it.
The panel sends status selections separately in bounded chunks tied to the
current loaded snapshot, rather than putting notification IDs in every request.
Large loaded lists therefore do not hit a selection-header limit or block
refresh, search, Read, or Done. Incomplete selections never start new lookups;
changed views discard the remaining chunks and send a fresh selection.
Status-selection failures are reported in the panel and retried automatically
without disabling inbox actions.
Up to twenty status lookups run concurrently across panels sharing the provider;
icons appear as their lookups finish, so completion order can differ from row
order. Changes to the view reprioritize remaining rows as slots become available.
Already dispatched requests may finish after a group is collapsed. Duplicate
lookups share the cache, rate-limit backoff still applies, and inbox reads and
Read/Done actions do not wait for outstanding status lookups.
Cached results can appear immediately. A small spinner fills the icon slot while an initial status is
loading. It stays still when reduced motion is enabled, and known icons remain
visible during background refreshes.
For CI rows, the initial spinner lasts until the run and any failed-job lookup
finish, even when the reported result is already known. Row navigation is
temporarily unavailable during that initial lookup; Read and Done remain separate
controls. Once resolution finishes, the row opens the logs, run summary, or
Actions fallback. Unsupported titles and lookup failures do not leave rows
permanently disabled. Refreshes of an already resolved destination leave it
clickable without replacing its known icon with a spinner. A changed workflow
notification can require resolving a new destination.
Desktop polling does not fetch these details.
Unexpected lookup failures preserve known statuses and check times, identify
previously checked API results as stale, and report a sanitized error.
A neutral icon with a **Status not loaded yet** or **Status unavailable** description is shown when
the status is not known; unavailable status does not hide the notification.
Repository access or organization SSO restrictions can prevent status lookups
even when the notification itself is available. While status lookups are running,
the visible panel checks the local provider every second so completed icons appear
sooner. It returns to the normal five-second local poll when lookups finish and
stops polling when hidden. This does not shorten GitHub's five-minute status cache
or bypass request limits; failed lookups retry after their backoff.

Click the title, metadata, or empty space outside the action column to open the
row's GitHub destination.
Rows use native links, including keyboard and modified-click behavior, without
underlining their titles or showing a generic destination tooltip over the row.
Status/freshness details remain in the icon's screen-reader description, without
a hover tooltip. Read and Done remain separate controls; opening a row
does not send a read/done request from the extension.
Background refreshes do not restore canvas focus after you move to the Copilot
composer or another window. Focus restoration within an active canvas is preserved.
Subject status, freshness, and destination updates preserve row links, their
status icons and type/number labels, and action buttons in place, so they cannot
cancel a pointer click already in progress or rebuild unrelated rows.
Notification content or selection changes still reconcile the displayed list.
Unchanged polling keeps button labels intact so clicks on Load more, Collapse,
and attention tabs are not cancelled partway through a pointer press.
Opening a row or the inbox toolbar link, including Cmd-click or middle-click,
clears its hover highlight. Losing window focus clears hover highlights on rows
and controls; they resume on fresh pointer input
rather than reappearing just because the window regains focus.
Read/Done hover tooltips close when the pointer leaves, including after a refresh.
Keyboard-focused tooltips remain available, and Escape dismissal survives row updates.
Read/Done actions and batch retries remain unavailable while a search change is
pending, so they cannot act on the previous selection. You can keep editing the
search; actions become available once the displayed results catch up.
Search waits for input-method composition to finish before applying a draft.
Holding Enter does not repeat Read, Done, or batch-control actions after focus
moves; release and press it again to perform another action.

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
**Settings > Hide empty tabs** is on by default and hides tabs with zero loaded notifications.
**All** and the selected tab always stay visible, even when empty. Tabs reappear
when matching notifications are loaded. Search does not affect tab visibility,
and keyboard navigation skips hidden tabs.
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
