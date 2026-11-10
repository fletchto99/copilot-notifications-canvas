# Copilot actions

[README](../README.md) | [Usage](usage.md) | [Installation](installation.md) | [Settings](settings.md) | [Development](development.md)

The Copilot button starts a focused session for the selected notification.
Each new session starts in **plan mode**, summarizes the item first, and remains
read-only. Editing files, committing, pushing, rerunning workflows, or making
GitHub changes requires explicit approval. Reviews remain drafts.

**Read/Done never changes as a side effect.** Opening an existing session only
navigates to it; no new prompt is sent and its work is not interrupted.

## Actions by notification type

The button's tooltip and accessible label describe the task:

| Item | Button label | What the prompt does |
| --- | --- | --- |
| Open issue | Investigate with Copilot | Reads the issue, discussion, and relevant code; summarizes the problem and proposes an approach. |
| Closed issue | Summarize with Copilot | Summarizes the problem, documented outcome, and reason for closure. Does not propose fixes or reopening. |
| Your open or draft PR | Continue with Copilot | Reads the diff, discussion, reviews, and checks to identify outstanding work. |
| Another person's open or draft PR | Review with Copilot | Summarizes the PR, then asks which review skill to use before reviewing or drafting findings. |
| Merged PR | Summarize Changes | Summarizes what changed, why where supported by evidence, and its impact, then stops. |
| Closed, unmerged PR | Summarize Changes | Summarizes the proposed changes and documented closure reason, then asks whether you want help reopening it. |
| Discussion | Summarize with Copilot | Summarizes the post, replies, decisions, accepted answer, and unresolved questions. Does not post or propose implementation. |
| Commit | Summarize commit | Examines the exact commit's diff and explains code, behavior, and test changes, not just its message. |
| Release with a specific linked release ID | Summarize Release Notes | Summarizes documented features, fixes, breaking changes, and upgrade guidance for that release. Never downloads or executes release assets. |
| Resolved or uniquely matched failed, timed-out, or startup-failed CI run | Investigate CI failures with Copilot | Examines the selected run attempt, failed-job logs, and matching code to identify likely causes. |

Summary actions stop after the requested summary, except for the reopening
question on closed PRs. Investigation actions can continue read-only and propose
implementation separately.

## Availability

Rows keep fixed **Copilot**, **Read**, and **Done** columns. Unsupported Copilot
actions leave empty, non-interactive space. Read stays visible but disabled on
already-read rows, so the remaining buttons do not move. Group Read/Done controls
align with the same columns. Turning **Settings > Copilot integration** off
restores the two-column layout, hides Copilot buttons, and blocks new handoffs.
The preference defaults on and does not stop or change sessions already started.

On first load, eligible rows show a disabled **Checking Copilot availability...**
button while the host's session tools initialize. The inbox, links, and Read/Done
controls remain usable. The button updates automatically without a manual refresh.
The host exposes only currently initialized tools, so an open canvas does not
necessarily mean its session tools are ready. Discovery retries incomplete tool
metadata or transient failures after 1 second, then 2 seconds, then every 5 seconds
for up to one minute. The loading indicator stops after that minute even if a
discovery request is still pending. Eligible rows then retain a disabled
**Copilot tooling unavailable** button instead of disappearing. Hosts without the
discovery APIs show that disabled state immediately.
Discovery returns to checking about once per minute while the panel is visible,
without overlapping pending requests, and enables the button automatically if the
tools become available. Discovery never starts a session or changes notification
state.

PR ownership uses the authenticated GitHub CLI user and actual PR author,
not the notification reason. While identity/status is loading, the label is
**Work with Copilot**; clicking resolves the task before confirmation.

Merge-queued PRs keep a disabled **PR in merge queue** button. Tab navigation
skips it; its hover tooltip explains why the action is unavailable. Notification
links and Read/Done remain available. Open or draft PR handoffs wait for verified
merge-queue membership; pending or failed checks cannot authorize a session.
CI actions wait while run/job links load. Unresolved or ambiguous matches remain
disabled rather than guessing a destination.

Buttons require a host offering session-tool execution and the app's
session/repository tools with support for detached creation and plan-mode
kickoffs. Older hosts cannot start a handoff; the extension never falls back
to creating a nested child. Actions are unavailable for custom development APIs.

## Starting a session

By default, click the icon to inspect the selected reference and available
sessions. **Start session** creates an independent, root-level session in the
selected repository, not a child of the session containing the canvas.
These generic sessions do not have the app's native issue/PR linkage.

After repository setup, checkout preparation, and the final existing-session
check, the extension fetches fresh issue/PR state or release/commit metadata
immediately before creating a session. Changed or unavailable context stops
creation rather than using cached row state or silently changing the task.
Open the action again to confirm any updated task or reference.

The creation request includes the plan-mode prompt, which the app queues until
the new session is ready. Startup activity does not turn it into an
existing-session choice or discard the prompt.

Repositories not configured in the app require **Clone repository and start**.
If the host cannot set up repositories, add the repository in Copilot first.
The app's permission and repository-trust checks still apply.

Preparation and starting are queued so permission prompts or cloning can take
longer than an HTTP request. A spinner and accessible status distinguish
preparing the checkout, fetching the selected commit, starting the session, and
opening it. Progress stays visible if you close the dialog; closing does not
cancel an already submitted handoff. Failures are shown explicitly and are
never automatically retried. Check the app for an existing session before retrying.

## Exact-commit preparation

New sessions use a worktree at the repository's configured base for issues,
discussions, and release summaries; the verified PR head commit for PRs,
including fork PRs; the selected commit's full SHA for commit summaries; or the
failed run's immutable commit for CI investigations.

PR metadata is refreshed for each preparation rather than reusing an older
head commit. Before creating a PR, CI, or commit worktree, the extension checks
that the selected commit exists in the configured checkout. If missing, it
fetches the PR's head ref or the selected SHA from GitHub using `gh` as a
command-scoped Git credential helper, then verifies the exact SHA again.
Fetching does not switch branches, touch working files, or update tags,
tracking refs, or `FETCH_HEAD`.

An inaccessible checkout, failed fetch, or unavailable commit stops the handoff
with an explicit error; it never falls back to the default branch. Exact-commit
preparation requires a host-exposed checkout path accessible to the extension.
Remote-only repositories without that path are unsupported for new PR, CI, and
commit handoffs. Existing-session reuse does not fetch or change its checkout.

## Confirmations and existing sessions

To avoid the routine popup, turn on **Skip routine confirmations** before
confirming. Cancel does not save that choice. Future row clicks start a new
summary-first session directly when no matching session exists.
Restore the popup with **Settings > Confirm Copilot actions**.

Cloning an unconfigured repository, confirming an inferred CI association, and
choosing an existing or new session always show the popup. The preference does
not bypass Copilot permissions or review-skill questions.

If a matching session exists, the popup offers **Open existing session** and
**Start a new session**, even with routine confirmations off. Opening only
navigates: it does not send another prompt, change its mode, or interrupt its
current work or sidebar placement. New sessions are matched by repository and
their generated issue, PR, discussion, commit, release-ID, or run/attempt name;
renaming one prevents that name-based reuse. Existing native issue/PR links are
also recognized.

Choose **Start a new session** for a fresh start, including after an earlier
workspace initialization failed. This creates a separate summary-first session;
it never repairs, restarts, archives, or deletes the old one. The extension does
not guess whether a session failed from its activity status. Every creation
rechecks matches after repository setup and commit preparation, including direct
starts. If a match appears or the shown matching sessions change, it asks you
to choose again.

If the repository is no longer configured, starting fresh also requires
**Clone repository and start a new session**. Long CI session names and commit
session identifiers are shortened to fit the host's 40-character limit;
prompts retain the complete references and full SHAs.

## Action-specific safeguards

### Issues

Closed issue summaries distinguish completed, not-planned, and duplicate
outcomes; closure is not assumed to mean fixed. The session stops after the
summary rather than proposing a fix, implementing changes, or offering to
reopen the issue. Fresh issue metadata determines the task before confirmation
and is checked again when starting. If an issue closes or reopens, open the
action again to confirm the updated task.

### Pull requests

For another person's open or draft PR, the session pauses after its summary
to ask which review skill to use. It suggests `review` when available, or lets
you choose another available skill, and waits before reviewing or drafting
findings. If no suitable skill is available, it asks how to proceed rather than
assuming or installing one. Your own open or draft PRs, open issues, and CI
investigations do not ask for a review skill.

Merged PR summaries apply to both your own and others' PRs. They do not draft
review findings, propose implementation, or offer reopening.

Closed, unmerged PR summaries describe proposed changes without implying they
were merged. After the summary, the session offers **Help me reopen the PR**
and **Keep it closed**, then waits for your answer. It never reopens the PR,
restores a branch, or makes changes without explicit approval. If you want
help, it checks the current PR state, head branch availability, and permissions
before proposing next steps.

If a PR closes, merges, or reopens after a confirmation was shown, open the
action again to confirm the updated task.

### Discussions and commits

Discussions can be summarized whether open, answered, or closed. The prompt
follows pagination as needed, discloses access or pagination limits, and
distinguishes agreed outcomes from proposals without inferring consensus.
It does not assume the thread is resolved and reports an unavailable thread
as a limitation rather than an empty discussion.

Short commit references are resolved to a verified full SHA before confirmation.
A changed or ambiguous reference blocks starting. Merge-commit summaries
identify the parent comparisons used; empty commits are reported as having no
code changes. No fixes or review findings are requested.

### Releases

The confirmation shows the specific release URL verified from the notification's
release ID. Metadata is checked again when starting; deleted, draft, or retagged
releases cannot silently replace the confirmed release. The session reads notes
by release ID and never substitutes the latest release. Empty or unavailable
notes are reported honestly rather than filled in with guessed changes.

The row link still opens the repository's releases page. Notifications without
a valid release ID keep a disabled Copilot button explaining that no specific
release is linked; the extension never infers a tag from the notification title.
The repository checkout provides context only, not a checkout of the release
tag. Release summaries use the same confirmation, cloning, and session-reuse
safeguards as other actions.

### CI runs

A uniquely inferred CI run can be investigated. The confirmation identifies
the association as inferred and shows the selected run and attempt. The provider
validates that exact attempt with GitHub before offering to start; it never
substitutes a newer rerun. A failed-job link retains its parent run and attempt
for the handoff even though the row opens the individual job's logs. Run
summaries also include the attempt whenever GitHub supplies it.

## Privacy

Only the selected validated reference, required identifiers, and fixed task
instructions are shared with Copilot, not the notification title, body, release
notes, or surrounding inbox. The destination session fetches the item's details.
The reference and fetched context belong to Copilot's session history; the
extension keeps no persistent handoff ledger.

Notification content, comments, release notes, commit messages, diffs, and logs
are treated as untrusted evidence, not instructions. Read/Done remains unchanged.
