# Unread Notifications

A view of unread GitHub notifications inside the GitHub Copilot app,
grouped by repository. Newest activity first, with collapsible repository groups, counts,
title/repository search, one-click row and repository **Mark as read** actions, and a compact
layout that follows the app's theme. A Settings dropdown provides opt-in sound
and auto-open on new sessions.

![Unread Notifications canvas showing a repository group, search, settings, and mark-as-read controls](docs/images/unread-notifications.png)

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

## Install with Copilot

Have Copilot install this extension for you with this prompt:

```text
Install the Unread Notifications canvas from
https://github.com/fletchto99/copilot-notifications-canvas as a user-wide
GitHub Copilot extension available across sessions. Follow the repository's
manual "Install for all projects" steps using node scripts/install.mjs.
Preserve existing settings and do not overwrite locally modified files or
bypass installer safeguards. Use my existing GitHub CLI sign-in; report
missing prerequisites or permissions without changing credentials. After
installation succeeds, reload extensions and open Unread Notifications
(canvasId: github-notifications).
```

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

Upgrades leave the extension directory and `artifacts/` in place, including while
older running providers save settings. Runtime files are staged, backed up, then
replaced individually, with the entry point published after its supporting files.
Wait for installation to finish before reloading extensions. A failed publication
restores the previous runtime without rolling back settings changes. Unexpected
concurrent runtime edits are never overwritten; an incomplete rollback reports
where the remaining backup files were preserved for recovery.

Concurrent installers use a separate directory lock outside the extension.
Completed operations release it; a later installer can reclaim a lock belonging
to a process that has exited. An active owner's or unrecognized lock is left alone.

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

The [test workflow](.github/workflows/tests.yml) runs this command with Node.js 22
on `ubuntu-slim` for pull requests and pushes to `main`, or by manual dispatch.
It needs no dependency installation or GitHub credentials for the tests.

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
