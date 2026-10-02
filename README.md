# Unread Notifications

A view of unread GitHub notifications inside the GitHub Copilot app,
grouped by repository. Newest activity first, with collapsible repository groups, counts,
title/repository search, one-click row and repository **Mark as read** actions, and a compact
layout that follows the app's theme. A Settings dropdown provides opt-in sound
and auto-open on new sessions.

## Prerequisites

- A GitHub Copilot app build with extension canvases enabled. The canvas API is experimental.
- [GitHub CLI](https://cli.github.com/) (`gh`) available to the app, already signed in to **github.com**.
- The CLI account needs `notifications` or `repo` scope. GitHub's notifications
  endpoints do not support fine-grained personal access tokens. Use the usual
  `gh auth login` browser sign-in, or a supported classic token stored by `gh`.
- Node.js 22 or later for installation and tests. No npm packages or SDK installation are needed.

Check sign-in with `gh auth status --hostname github.com`. If required, sign in
with `gh auth login --hostname github.com`, or request the missing scope with
`gh auth refresh --hostname github.com --scopes notifications`. Organization SSO
may need separate authorization. These commands change your authentication only
when **you** run them; the extension never runs them or retrieves a token.

This first version supports GitHub.com, not GitHub Enterprise Server. It uses the
active GitHub.com account from `gh`'s existing credential store. Restart/reload the
extension after switching CLI accounts to discard the previous account's in-memory
cache. Restricted environment tokens are not requested from Copilot; signing in
through `gh`'s credential store avoids granting this extension token environment access.

## Open in this project

Clone/open this repository as a Copilot project. The app discovers
`.github/extensions/github-notifications/extension.mjs`. Ask Copilot to:

> Reload extensions, then open the Unread Notifications canvas.

The canvas type is `github-notifications`, display name **Unread Notifications**,
provider `project:github-notifications`. The agent opens a panel with an arbitrary
instance ID, for example:

```json
{
  "canvasId": "github-notifications",
  "instanceId": "inbox-1",
  "input": { "query": "" }
}
```

The UI fetches automatically when visible; there is no manual Refresh button.
The read-only `refresh` action and `/api/refresh` endpoint remain available for
programmatic use and automatic polling, with the same polling/rate protections.
Agent actions are `get_state`, `get_settings`, `refresh`, `set_filters`
(`query` up to 200 characters), and `load_more`.
Actions return only aggregate counts, status, and timing metadata, never titles,
repository names, or the search text. Invalid inputs and failed actions raise
structured errors. `get_state`, `get_settings`, `refresh`, and `load_more` take `{}`.
There is no agent-callable mutation action. Marking read requires a row button
click or a repository **Mark N as read** button click in the canvas.
The optional `mode: "unread"` input remains accepted for existing panel compatibility;
other modes are rejected. All requests and pagination are restricted to unread notifications.

## Install for all projects

From this repository:

```sh
node scripts/install.mjs
```

This copies only the twelve runtime source/assets files and an ownership manifest to
`${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications`. To choose a
different Copilot home explicitly:

```sh
COPILOT_HOME=/path/to/copilot-home node scripts/install.mjs
```

Then reload extensions in the desired Copilot chat and ask to open **Unread
Notifications**. The user-wide provider is `user:github-notifications`. The project
copy shadows a same-named user copy while working in this repository.

Installation is repeatable: an untouched installation made by this script can be
updated by running it again from a newer checkout. It refuses an unrelated folder,
symlink destination, extra files, or locally edited runtime files. Preserve/move
such a directory yourself before reinstalling. It does not copy tests, a checkout,
logs, caches, or credentials, and it never changes other extensions. Existing
`artifacts/` settings and other user artifacts are preserved during upgrades;
an artifacts-only folder created by the project extension is also supported.

## Inbox behavior

- **Unread only:** the canvas requests `all=false` and shows only unread
  notifications. There are no All/Unread tabs. Read-but-still-inbox notifications
  are intentionally out of scope; use **Open GitHub inbox** for the website's full
  Inbox. GitHub's public API does not expose a Done state, so this is an unread
  view rather than an exact mirror of the website Inbox.
- **Pagination:** initially loads up to 50 items. **Load more** follows GitHub's
  `Link` header, one page at a time, without an arbitrary total cap. Counts always
  describe loaded items, not the entire account. Search covers loaded titles and
  repository names; the UI explicitly tells you when older pages remain.
- **Automatic refresh:** visible panels refresh no faster than every two minutes,
  or GitHub's `X-Poll-Interval`, whichever is longer. HTTP `ETag`/`If-None-Match` or
  `Last-Modified`/`If-Modified-Since` validators avoid refetching unchanged pages.
  All previously loaded pages are reconciled on refresh, and duplicate thread IDs
  are removed. GitHub's changing inbox is not a transactional snapshot: changes
  during pagination settle on subsequent refreshes. Last-checked and next-refresh
  times remain visible. Recoverable failures retry automatically while visible,
  respecting backoff; sign-in/scope errors require fixing `gh` authentication
  first. Reopen the canvas if its local connection does not recover.
- **Rate limits:** serialized requests and a per-provider cache are shared between
  panels. `Retry-After`, exhausted quota reset times, and exponential error backoff
  pause requests. Authentication, scope, network and malformed-response errors
  remain visible; previously loaded items are labeled stale, not silently dropped.
- **Visibility/lifecycle:** document visibility and intersection stop renderer
  polling when hidden; closing stops its server and aborts outstanding subprocess
  work. There is no background GitHub polling timer in the provider. Separate app
  sessions have separate providers/caches; avoid opening many simultaneous inboxes.
- **Mark as read:** a row's button sends `PATCH /notifications/threads/{thread_id}`.
  Only known loaded unread IDs are accepted. The row is removed after GitHub's
  documented `205` or `304` confirmation, never optimistically. Failed requests
  retain the row and show an actionable error. Duplicate requests are rejected;
  writes are serialized with at least one second between them and respect GitHub
  rate-limit backoff without imposing the read polling interval on every click.
  Shared panels update on their next local state check; cached rows and conditional
  validators are invalidated. Automatic refresh reconciles pagination before
  loading more.
  Genuinely newer activity on the same thread can reappear. Reading is not Done,
  deletion, or unsubscribing.
- **Repository actions:** each repository header has **Mark N as read**, where N
  is exactly the number of shown, loaded notifications in that group. Search
  narrows this selection; collapsing a group does not change it. **One click starts
  marking that exact selection as read immediately**, without a confirmation
  dialog. Successful rows disappear and counts update quietly; no completion
  alert or success banner is shown.

  The server captures one immutable selection of thread IDs and activity
  timestamps at the click. A small fingerprint of the displayed group rejects a
  stale or different selection without sending an unbounded HTTP array of IDs.
  No total selection cap is silently applied: any already-loaded group can be
  selected. The clicked selection does not include older/unloaded items,
  other repositories, search-hidden rows, or notifications arriving after capture.
  Immediately before each write, changed/no-longer-unread items are skipped,
  including newer versions observed by another panel while waiting in the queue.
  GitHub does not offer a conditional mark-read operation, so an update arriving
  on GitHub after our last observation can still race the PATCH.

  The click starts a nonblocking, panel-owned job. It sends only the same
  serialized, rate-limited **per-thread PATCH** used by row buttons, never the
  repository-wide `PUT /repos/{owner}/{repo}/notifications`. The UI polls local
  progress, not GitHub, and shows a small in-button progress indicator while
  running. On partial failure or cancellation, it reports accurate succeeded,
  failed, skipped, and not-attempted counts; unsuccessful rows stay visible.
  Confirmed successes disappear and synchronize across panels. The first
  auth/rate/network failure stops the remaining batch. **Retry remaining** starts
  another job immediately with one click, only for unchanged,
  currently shown failed/unattempted members of the original selection; it never
  repeats acknowledged successes or adds new rows. Skipped changed rows require
  a separate fresh group selection.

  Only one active job is kept per panel. While it is running,
  that panel's refresh, search, loading, and other read controls are paused;
  overlapping read requests from other panels are also blocked. **Stop remaining**
  cancels queued work but lets an already-sent PATCH report its outcome. Closing
  the canvas or reloading the provider aborts outstanding work; a request already
  accepted by GitHub cannot be undone, so wait for an automatic refresh or reopen
  the canvas before retrying an uncertain outcome. Hidden panels do not poll
  progress, but an already-started job can continue until stopped or closed.
  Successful job state is cleared automatically;
  meaningful failure results remain until retried, replaced by another group click,
  or dismissed. Results are not stored on disk and are lost
  on provider restart; reopening the same live panel can recover its current
  progress. Batch removal and pagination shifts never generate a sound event.
- **Optional sound:** open **Settings**, then click **Play sound: Off** to enable
  a short, gentle synthesized chime; click **Play sound: On** to disable it.
  Sound starts off, belongs only to the
  current panel document, and resets on reload/reopen. Browser audio permission or
  playback failures switch it off with a visible retry message. Closing the page
  releases its audio context. No audio files, external assets, OS notifications,
  background polling, or background audio are used.

  A successful visible refresh can chime once for a new activity batch, regardless
  of search text or collapsed groups. Detection compares unfiltered unread thread
  IDs and GitHub `updated_at` timestamps against the highest previously observed
  timestamp. Later activity on an existing thread can qualify. Initial loads,
  unchanged/cached/304 results, searches, state-only reads, loading older pages,
  and older rows moving onto the first page are silent. Equal timestamps are not
  considered later activity. Failed or partial refreshes do not advance this
  baseline. It is maintained even while sound is off; a batch also needs an
  activity timestamp after sound was enabled, so enabling does not chime for
  backlog. Returning from a hidden view or reconnecting establishes a silent
  baseline instead of playing catch-up sounds. This is a polling convenience, not
  a guaranteed notification delivery channel.
- **Auto-open:** **Settings > Open on new sessions** defaults off. When enabled,
  the extension can open one `unread-notifications-startup` panel after joining a
  fresh session with a canvas renderer. It uses the supported SDK capability,
  session-event, and `session.rpc.canvas.open` APIs. It does not prompt the model
  or use a host bridge. Install user-wide for this to apply outside this repository;
  the project copy only loads here.

  Auto-open is deliberately conservative: resumed/already-active sessions, sessions
  with an existing canvas, and sessions already checked by this extension are not
  opened or focused again. If the renderer connects late, it can open only before
  session activity starts. Closing the panel does not reopen it during that session,
  and disabling the preference does not close any panel. Startup/storage failures
  produce a sanitized extension warning instead of retry loops.
- **Links:** issues, pull requests, commits and discussions with recognized subject
  URL shapes link directly to their GitHub web pages. Release API IDs are **not**
  release tags, and check-suite IDs are **not** Actions run IDs: those link to the
  repository's releases/Actions pages with explicit destination labels. Unsupported,
  unavailable, or unsafe subject URLs fall back to the GitHub inbox. No additional
  per-subject API requests are made.
- **State:** GitHub owns notification state; notification data is never written
  to disk. Search, collapsed groups, and sound are transient; reload
  recreates a panel from its original open input and refetches GitHub data.
  The app may retain open input in its session history; avoid putting sensitive
  search text in agent inputs if you do not want it in that history.

### Preference storage

Only the auto-open boolean is saved, in
`${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications/artifacts/settings.json`.
Updates preserve unknown JSON keys, use a temporary file and atomic rename, and
serialize concurrent writers with `.settings.lock`. Invalid JSON, unsafe files,
and I/O failures are surfaced; the previous settings are not silently replaced.
If a crash leaves a lock, verify that no settings update is running before
removing it manually.

A small `files/github-notifications-startup.json` marker in the SDK session
workspace records that startup has been checked, even when auto-open was off.
It contains no notification data. Settings are not keyed by transient panel IDs,
ports, or localStorage. The installer preserves the artifacts directory.

## Privacy and explicit actions

Listing, polling, searching, and rendering only use `gh api --method GET` against
the notifications list endpoint on GitHub.com. Only an explicit **Mark as read**
row or repository button click sends narrowly scoped per-thread PATCHes.
The extension never marks Done,
changes subscriptions, requests new credentials, or changes permissions. Opening
an external link also leaves this surface: **GitHub itself may mark a notification
read when you visit it.**

Notification content stays in provider/renderer memory, is not sent to the agent,
and is never logged or persisted by this extension. No third-party assets,
analytics, telemetry, or remote scripts are used. `gh` owns authentication;
credentials never enter the renderer. API errors and subprocess failures are
sanitized rather than echoing response bodies or stderr.

Each panel has its own `127.0.0.1`-only server on an ephemeral port. A random
256-bit per-instance capability in the URL fragment authorizes JSON requests.
The server validates Host, methods, routes, origins, content type, and body size;
it has no wildcard CORS. Responses use `no-store`, a restrictive CSP, and
`no-referrer`. Notification text is rendered with DOM `textContent`, never HTML.
Only HTTPS GitHub.com links are emitted. The loopback boundary does not defend
against malware or privileged software already running as your OS user.

## Development

```sh
node --test test/*.test.mjs
```

All tests use synthetic fixtures, including mutation tests, real loopback HTTP integration and
installer checks. No test needs authentication or contacts GitHub. There is no
build step. The SDK import is resolved automatically by the Copilot runtime; do
not install a separate SDK package.

Runtime files live together in `.github/extensions/github-notifications/`:
`extension.mjs` wires lifecycle and actions, `github.mjs` handles `gh` and HTTP
polling, `inbox.mjs` owns per-panel state, `model.mjs` handles normalization/links,
`server.mjs` serves the protected UI, `index.html`, `styles.css`, `app.mjs`
provide the renderer, `batch.mjs` coordinates clicked repository selections,
`sound.mjs` manages opt-in browser audio, `settings.mjs`
stores the user preference, and `startup.mjs` coordinates conservative auto-open.

After any edit, reload extensions. Use extension **list/inspect** to check the
provider and its log, then inspect canvas capabilities and open/invoke actions.
Logs deliberately exclude API data. Use synthetic data for screenshots and bug
reports; never commit personal notification titles, private repository names,
tokens, or captured responses to this public repository.

### API references

- [Notifications payloads, scopes, ordering and polling](https://docs.github.com/en/rest/activity/notifications)
- [REST pagination and Link headers](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [Conditional requests and rate-limit handling](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [Release API IDs and web URLs](https://docs.github.com/en/rest/releases/releases)
- [Check-suite payloads](https://docs.github.com/en/rest/checks/suites)

The extension pins REST API version `2022-11-28` and uses 50 items per page.
