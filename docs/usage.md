# Usage

[README](../README.md) | [Installation](installation.md) | [Settings](settings.md) | [Development](development.md)

**Jump to:** [Find](#find-notifications) | [Status icons](#status-icons) |
[Views](#choose-a-view) | [Read / Done](#mark-read-or-done) | [Copilot](#work-with-copilot) |
[Refresh](#refresh-and-recover) | [Keyboard](#keyboard-and-preferences)

The canvas shows GitHub's read and unread inbox items by default. Choose
**Settings > Show notifications > Unread only** to narrow the view.
Done notifications are excluded in both views. Pages contain up to 50 items.
**Search, counts, and bulk actions cover loaded items only.** Use **Load more**
to include older notifications.

## Work with Copilot

Rows keep fixed **Copilot**, **Read**, and **Done** columns. Unsupported Copilot
actions leave empty, non-interactive space. Read stays visible but disabled on
already-read rows, so the remaining buttons do not move.
Group Read/Done controls align with the same columns. Turning Copilot integration
off restores the two-column Read/Done layout.

On first load, eligible rows show a disabled **Waiting on copilot SDK Availability**
button while the host's session tools initialize. The inbox, links, and Read/Done
controls remain usable. The button updates automatically without a manual refresh.
The host exposes only currently initialized tools, so an open canvas does not
necessarily mean its session tools are ready. Discovery retries incomplete tool
metadata or transient failures after 1 second, then 2 seconds, then every 5 seconds
for up to three minutes, stopping as soon as the required tools are available.
The loading indicator stops after three minutes even if a
discovery request is still pending. Eligible rows then retain a disabled
**Copilot tooling unavailable** button instead of disappearing. Hosts without the
discovery APIs show that disabled state immediately.
Discovery returns to checking about once per minute while the panel is visible,
without overlapping pending requests, and enables the button automatically if the
tools become available. Discovery never starts a session or changes notification
state.

The Copilot button's tooltip and accessible label describe the task:

| Item | Task |
| --- | --- |
| Issue | Investigate with Copilot |
| Open or closed discussion, including answered discussions | Summarize with Copilot |
| Your open or draft PR | Continue with Copilot |
| Another person's open or draft PR | Review with Copilot |
| Resolved or uniquely matched failed, timed-out, or startup-failed CI run | Investigate CI failures with Copilot |

Closed, merged, and merge-queued PRs keep a disabled Copilot button labeled
**PR closed**, **PR merged**, or **PR in merge queue**. These controls are skipped
by Tab navigation; their hover tooltips explain why the action is unavailable.
Their notification links and Read/Done controls remain available. **Settings > Copilot integration**
defaults on; turn it off to hide all Copilot buttons and block new handoffs.
This does not stop or change sessions already started.

PR ownership uses the authenticated GitHub CLI user and actual PR author,
not the notification reason. A PR handoff waits for verified merge-queue
membership; pending or failed queue checks cannot authorize a session.
While identity/status is loading, the label is
**Work with Copilot**; clicking resolves the task before confirmation. CI actions
wait while run/job links are loading. Unresolved or ambiguous matches remain
disabled rather than guessing a destination.

A uniquely inferred CI run can be investigated. The confirmation explicitly
identifies that association as inferred and shows the selected run and attempt.
The provider validates that exact attempt with GitHub before offering to start;
it never substitutes a newer rerun. A failed-job link retains its parent run
and attempt for the handoff even though the row opens the individual job's logs.
Run summaries also include the attempt whenever GitHub supplies it.

By default, click the icon to inspect the selected reference and available sessions.
**Start session** creates an independent, root-level session in the selected
repository, not a child of the session containing the canvas. It uses a worktree
at the repository's configured base for issues and discussions, the verified PR head commit
(including fork PRs), or the failed run's immutable commit.
These generic sessions do not have the app's native issue/PR linkage.
PR metadata is refreshed for each preparation rather than reusing an older
head commit. Before creating a PR/CI worktree, the extension checks that the
selected commit exists in the configured checkout. If missing, it fetches the
PR's head ref or the CI commit from GitHub using `gh` as a command-scoped Git
credential helper, then verifies the exact SHA again. Fetching does not switch
branches, touch working files, or update tags, tracking refs, or `FETCH_HEAD`.
An inaccessible checkout, failed fetch, or unavailable commit stops the handoff
with an explicit error; it never falls back to the default branch. Exact-commit
preparation currently requires a host-exposed checkout path accessible to the
extension. Remote-only repositories without that path are unsupported for new
PR/CI handoffs. Existing-session reuse does not fetch or change its checkout.
The creation request includes the plan-mode prompt, which the app queues until
the new session is ready. Startup activity does not turn it into an
existing-session choice or discard the prompt.
Its first substantive response summarizes the item, its current state, and
the next investigation steps. It can then investigate read-only; implementation,
commits, pushes, workflow reruns, and GitHub changes need explicit approval.
Reviews remain drafts.

Discussion sessions read the thread, comments, and replies, then summarize its
open or closed state, main viewpoints, decisions or accepted answer, and unresolved
questions. They distinguish agreed outcomes from proposals and disclose any
access or pagination limits. They stop after the summary and wait for further
instructions, without investigating code or changing GitHub state.

To avoid the routine popup, turn on **Skip routine confirmations** before
confirming. Cancel does not save that choice. Future row clicks start a new
summary-first session directly when no matching session exists. A spinner and
accessible status distinguish preparing the checkout, fetching the selected
commit, starting the session, and opening it. Progress stays visible if you
close the dialog. Errors are shown rather than silently retried.

Cloning an unconfigured repository, confirming an inferred CI association, and
choosing an existing or new session always show the popup. This option
does not bypass Copilot permissions or review-skill questions. Restore the
routine popup with **Settings > Confirm Copilot actions**.

For a PR authored by someone else, the new session pauses after its summary to
ask which review skill to use. It suggests `review` when that skill is available,
or lets you choose another available skill, and waits for your answer before
reviewing or drafting findings. If no suitable skill is available, it asks how
to proceed instead of assuming or installing one. Your own PRs, issues, discussions, and CI
investigations keep their existing flow.

If a matching session exists, the popup offers **Open existing session** and
**Start a new session**, even with routine confirmations off. Opening only
navigates: it does not send another prompt, change its mode, or interrupt its
current work or sidebar placement. New sessions are matched by repository and
their generated issue, discussion, PR, or run/attempt name; renaming one prevents that
name-based reuse. Existing native issue/PR links are also recognized.
Choose **Start a new session** for a fresh start, including after an earlier
workspace initialization failed. This creates a separate summary-first session;
it never repairs, restarts, archives, or deletes the old one. The extension does
not guess whether a session failed from its activity status. Every creation
rechecks matches after repository setup and commit preparation, including direct
starts with routine confirmations off. If a match appears or the shown matching
sessions change, it asks you to choose again.
If the repository is no longer configured, starting fresh also requires the
explicit **Clone repository and start a new session** confirmation.
Long CI session names are shortened to fit the host's 40-character limit;
the prompt still includes the complete run URL, attempt, and commit.

Repositories not configured in the app require **Clone repository and start**.
If the host cannot set up repositories, add the repository in Copilot first.
The app's permission and repository-trust checks still apply.

Preparation and starting are queued so permission prompts or cloning can take
longer than an HTTP request. Closing the dialog does not cancel an already
submitted handoff. Failures are shown explicitly and are never automatically
retried; check the app for an existing session before trying again.

Read/Done never changes as a side effect. Only the selected validated reference
and fixed task instructions are shared with Copilot, not the notification title
or surrounding inbox. The reference and fetched context belong to Copilot's
session history; the extension keeps no persistent handoff ledger.
Buttons appear only on a host offering session-tool execution and the app's
session/repository tools with support for detached creation and plan-mode
kickoffs. Older hosts without that capability cannot start a handoff; the
extension never falls back to creating a nested child. Actions are unavailable
for custom development APIs.

## Find notifications

Search by **title, issue/PR number, or repository**, then combine it with an
attention tab. The toolbar opens GitHub's inbox, refreshes, or opens Settings.

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

Tab counts ignore search; the status line combines the selected tab and search.
Refresh, Load more, and clearing search preserve the tab. **Hide empty tabs**
defaults on, but **All** and the selected tab remain visible. Search does not
change tab visibility.

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

Counters show **N total · M unread**. Read rows have no unread dot and use
lighter-weight titles. Each row shows its type/number, reason, update time, and
repository when absent from the group heading. Navigation hints are available
to screen readers, never added to visible metadata.

Click the title, metadata, or space outside the action column to open GitHub;
native keyboard and modified-click behavior works. Opening a link sends no
read/done request from the extension, though GitHub may mark it read on arrival.
Read/Done actions and retries wait while search results catch up, so they cannot
act on an old selection. Input-method composition finishes before search applies.

Changing **Show notifications** reloads the first page while retaining filters;
a failed reload preserves the previous view and shows an error. GitHub owns
completion state; the canvas stores no local completion history.
An agent's explicit `mode: "unread"` locks the selector to Unread only without
changing the saved preference or resetting pagination when it changes elsewhere.
Returning to `mode: "inbox"` restores that preference.

### Status icons

These describe the issue, PR, discussion, or check, **not Read/Done state**.
Icons distinguish states by shape as well as color; screen-reader descriptions
provide status, freshness, and failures without extra visible text or hover tooltips.

| Subject | States |
| --- | --- |
| Issue / PR | Green open; purple completed issue or merged PR; red closed unmerged PR; gray draft PR; gray slashed circle for not-planned or duplicate issues; yellow dotted merge icon for queued PRs |
| Discussion | Purple overlapping checkmarked bubbles for resolved; green checkmarked bubble for answered; gray open/reopened, slashed duplicate, or clock-marked outdated |
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
After a confirmed Read in **All**, the row stays and focus moves from Read to
Done; a second click on the disabled envelope cannot open the row.
A status update can unlock Done and move focus before the
Read acknowledgement arrives, without overriding focus moved elsewhere.
In **Unread only**, Read removes the row.
Done removes it in either view.

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

**Only that group's loaded tab/search matches are included**, even when collapsed.
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
| ? or the toolbar keyboard icon (before Settings) | Open the keyboard shortcut guide |
| Left/Right Arrow, Home, End | Switch visible attention tabs; edge scroll buttons do not change selection |
| Tab | Visit row links and separate Read/Done controls; empty-state panels remain focusable |
| Hover / focus a button | Show its action tooltip |
| Escape | Close the shortcut guide and restore focus, or dismiss a tooltip or open menu; dismissal survives row updates |
| Click or focus outside Settings | Close Settings |
| Hold Enter | Does not repeat Read/Done/batch actions after focus moves; release and press again |

Character shortcuts are enabled by default and can be disabled in
**Settings > Keyboard shortcuts**. They work only while the canvas has focus,
not while typing in search, editing text, composing with an input method, or
using Settings or the shortcut guide. Ctrl/Command/Alt combinations and native
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
