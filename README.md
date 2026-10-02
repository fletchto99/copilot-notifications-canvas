# Unread Notifications

A read-only view of unread GitHub notifications inside the GitHub Copilot app,
grouped by repository. Newest activity first, with collapsible repository groups, counts,
title/repository search, and a compact layout that follows the app's theme.

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

The UI fetches when visible. Agent actions are `get_state`, `refresh`, `set_filters`
(`query` up to 200 characters), and `load_more`.
Actions return only aggregate counts, status, and timing metadata, never titles,
repository names, or the search text. Invalid inputs and failed actions raise
structured errors. `get_state`, `refresh`, and `load_more` take `{}`.
The optional `mode: "unread"` input remains accepted for existing panel compatibility;
other modes are rejected. All requests and pagination are restricted to unread notifications.

## Install for all projects

From this repository:

```sh
node scripts/install.mjs
```

This copies only the eight runtime source/assets files and an ownership manifest to
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
logs, caches, or credentials, and it never changes other extensions.

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
- **Refresh:** manual and automatic refresh have the same rate protections. Visible
  panels refresh no faster than every two minutes, or GitHub's `X-Poll-Interval`,
  whichever is longer. HTTP `ETag`/`If-None-Match` or
  `Last-Modified`/`If-Modified-Since` validators avoid refetching unchanged pages.
  All previously loaded pages are reconciled on refresh, and duplicate thread IDs
  are removed. GitHub's changing inbox is not a transactional snapshot: changes
  during pagination settle on subsequent refreshes.
- **Rate limits:** serialized requests and a per-provider cache are shared between
  panels. `Retry-After`, exhausted quota reset times, and exponential error backoff
  pause requests. Authentication, scope, network and malformed-response errors
  remain visible; previously loaded items are labeled stale, not silently dropped.
- **Visibility/lifecycle:** document visibility and intersection stop renderer
  polling when hidden; closing stops its server and aborts outstanding subprocess
  work. There is no background GitHub polling timer in the provider. Separate app
  sessions have separate providers/caches; avoid opening many simultaneous inboxes.
- **Links:** issues, pull requests, commits and discussions with recognized subject
  URL shapes link directly to their GitHub web pages. Release API IDs are **not**
  release tags, and check-suite IDs are **not** Actions run IDs: those link to the
  repository's releases/Actions pages with explicit destination labels. Unsupported,
  unavailable, or unsafe subject URLs fall back to the GitHub inbox. No additional
  per-subject API requests are made.
- **State:** GitHub owns notification state. No notification data or preferences
  are written to disk. Search and collapsed groups are transient; reload
  recreates a panel from its original open input and refetches GitHub data.
  The app may retain open input in its session history; avoid putting sensitive
  search text in agent inputs if you do not want it in that history.

## Privacy and read-only guarantee

The extension only executes `gh api --method GET` against the notifications list
endpoint on GitHub.com. It never marks read/done, changes subscriptions, requests
new credentials, or changes permissions. Opening an external link leaves this
read-only surface: **GitHub itself may mark a notification read when you visit it.**

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

All tests use synthetic fixtures, including real loopback HTTP integration and
installer checks. No test needs authentication or contacts GitHub. There is no
build step. The SDK import is resolved automatically by the Copilot runtime; do
not install a separate SDK package.

Runtime files live together in `.github/extensions/github-notifications/`:
`extension.mjs` wires lifecycle and actions, `github.mjs` handles `gh` and HTTP
polling, `inbox.mjs` owns per-panel state, `model.mjs` handles normalization/links,
`server.mjs` serves the protected UI, and `index.html`, `styles.css`, `app.mjs`
provide the renderer.

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
