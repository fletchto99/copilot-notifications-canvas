# GitHub Notifications

[![GitHub Copilot: Canvas extension](https://img.shields.io/badge/GitHub%20Copilot-Canvas%20extension-8250df?style=flat&logo=githubcopilot&logoColor=white)](#prerequisites)
[![Latest release](https://img.shields.io/github/v/release/fletchto99/copilot-notifications-canvas?style=flat&color=0969da)](https://github.com/fletchto99/copilot-notifications-canvas/releases/latest)
[![CI status](https://img.shields.io/github/actions/workflow/status/fletchto99/copilot-notifications-canvas/tests.yml?branch=main&event=push&style=flat&label=CI)](https://github.com/fletchto99/copilot-notifications-canvas/actions/workflows/tests.yml)
[![Line coverage](https://raw.githubusercontent.com/fletchto99/copilot-notifications-canvas/badges/coverage.svg)](https://github.com/fletchto99/copilot-notifications-canvas/actions/workflows/tests.yml)
[![Node.js runtime: >=22](https://img.shields.io/badge/Node.js%20runtime-%3E%3D22-166534?style=flat&logo=nodedotjs&logoColor=white)](#prerequisites)

Your GitHub inbox in the GitHub Copilot app, grouped by repository or date, or
shown as a single newest-first list. **Show notifications** defaults to **All**,
showing read and unread inbox items; choose **Unread only** to narrow the view. Completed items
stay hidden in both views. Search, mark rows
or groups as read or done, start a focused Copilot investigation or review,
and opt into desktop notifications or auto-open.

![GitHub Notifications canvas with search and attention tabs including Mine, italic mine markers on authored items among ten synthetic notifications, seven unread, across three example repositories, issue, PR and discussion status icons, a failed check run, and fixed Copilot, read, and done columns with disabled Copilot icons on merged and queued PRs and dimmed envelopes on already-read rows](docs/images/github-notifications.png)

## Prerequisites

- A GitHub Copilot app build with extension canvas support (experimental).
- Node.js 22 or later for the extension runtime and installer.
- [GitHub CLI](https://cli.github.com/) (`gh`) available to the app and signed
  into **github.com** with `notifications` or `repo` scope.
- Copilot PR/CI handoffs also require Git 2.29 or later and the configured
  repository checkout to be accessible on the extension's execution host.

GitHub.com only; fine-grained personal access tokens are not supported.
See the [installation guide](docs/installation.md#prerequisites) for CLI
verification requirements and the sign-in check.

[Development tooling](docs/development.md#local-development) requires Node.js 24
or later; this does not change the packaged extension's runtime requirement.

<a id="installation"></a>
<a id="updating"></a>

## Installation and Updating

Paste this prompt into Copilot:

```text
Install or update the GitHub Notifications canvas as a user-wide Copilot
extension using the latest stable release from:
https://github.com/fletchto99/copilot-notifications-canvas

Follow docs/installation.md in that repository, including all verification
and settings-preservation requirements. Stop if any check fails.
After installation succeeds, reload extensions and open the canvas.
```

[Manual installation and updates](docs/installation.md) cover the
full procedure, verification requirements, and troubleshooting.

## Usage

- Filter with the attention tabs or search by title, issue/PR number, or repository.
- **Mine** shows loaded notifications for issues, PRs, and discussions you authored;
  those rows have an italic *mine* marker. A `+` on its count means authorship
  checks are pending or unavailable, not that unknown items are unowned.
- Choose **All notifications**, **Repository**, or **Date** in **Settings**.
- Set **Show notifications** in **Settings** to **All** for read and unread inbox
  items, or **Unread only** to narrow the view.
- Icons show issue/PR states, including a yellow dotted merge icon for queued PRs,
  discussion states, and check-suite results. Screen-reader descriptions include
  status, freshness, and failures; icons have no hover tooltips. Status loads for
  all loaded rows in expanded groups, with up to 20 lookups running concurrently
  across panels sharing the provider, without delaying the inbox.
  Authorship checks also warm issue/PR/discussion details for filtered and
  collapsed rows; merge queue and check-suite lookups remain limited to expanded matches.
  Releases, commits, security alerts,
  invitations, workflow runs, and agent sessions have static type icons;
  unknown types fall back to a bell without additional status lookups.
- Check-suite rows open resolved or conservatively matched runs, or the sole
  failed job's logs. Unresolved rows fall back to filtered Actions when possible,
  or the repository Actions page otherwise. Run references include the resolved
  attempt; Copilot validates that exact attempt rather than substituting a later rerun.
- Use the envelope to mark a row **read**, or the checkmark to mark it **done**.
  Already-read rows keep a dimmed, disabled envelope labeled **Already read**.
  Each group header offers the same bulk actions.
- Use the Copilot button before Read to investigate an issue or failed CI run,
  continue your own PR, or review another PR. Confirm the selected reference
  before starting a summary-first, read-only root-level session in that repository,
  independent of the session containing the canvas. Existing sessions are
  offered without interrupting them; unconfigured repositories require explicit
  cloning confirmation. See [Copilot actions](docs/usage.md#work-with-copilot).
  Closed, merged, and merge-queued PRs show disabled icons explaining their state.
  Matching sessions always offer **Open existing session** or **Start a new session**,
  even with routine confirmations off; neither choice modifies existing work.
  **Copilot integration** in Settings
  defaults on and can be turned off without changing existing sessions.
  The popup's **Skip routine confirmations** option remembers your choice after
  confirmation; restore it with **Settings > Confirm Copilot actions**.
- Use **J/K** to move between visible rows, **Enter** to open a focused link,
  **I** to mark the focused row read, and **Shift+E** to mark it done.
  Read advances to the next visible row after success. **/** focuses search;
  **Enter** in search focuses the first result once filtering finishes.
  **?** opens the shortcut guide. Disable character
  shortcuts in **Settings > Keyboard shortcuts** if preferred.
- Use **Load more** for older notifications. Search, counts, and bulk actions
  cover **loaded items only**, not your entire GitHub inbox.

See the [usage guide](docs/usage.md) for filtering, bulk actions, keyboard
controls, and refresh behavior. [Settings](docs/settings.md) covers saved
preferences and opt-in desktop alerts.

## Privacy

The extension does not log notification titles or repository names or save them
to its own files. Ordinary agent-facing canvas actions expose counts, not inbox
content. There is no telemetry or remote asset loading.

**Starting a Copilot action shares the selected GitHub reference and task
instructions with Copilot**, including the repository and issue/PR/run identifier
(and a PR's head commit or a failed run's commit and attempt). These are retained
in Copilot's session history, and the destination agent fetches the item's
details. Notification titles, bodies, and the rest of the inbox are not copied
into the handoff.
Confirmation is shown by default. If you opt out of routine confirmations,
a fresh row click still authorizes each handoff; cloning, inferred CI matches,
and choosing an existing or new session still require confirmation.

**Desktop alerts send repository names and titles to your OS**, which may retain
them in notification history or show them on the lock screen. System settings
control this, not the extension. Windows alerts also include a validated GitHub
destination URL so clicking opens the related item in your default browser.

The local `artifacts/` directory stores settings and desktop coordination data:
timestamps, hashed activity/thread IDs, watcher/process markers and sanitized
errors. GitHub CLI handles credentials; they never enter the canvas renderer.

GitHub CLI fetches notifications, the signed-in account's ID, authorship and the status of loaded issues, pull requests,
discussions and check suites, merge queue membership, bounded workflow-run matches for missing
links (including new individual Windows check alerts), the signed-in user ID for
Copilot PR ownership checks, selected PR/run handoff metadata, and public release
metadata. Inferred run links are identified in screen-reader descriptions and fall back
to filtered Actions when matching is inconclusive. Failed runs open the job log
viewer when exactly one job failed; the extension reads job metadata, not logs.
Status is
cached only in memory. Author and viewer IDs stay in the provider; the renderer
receives only the authorship result. Update checks do
not send notification content or download or execute release code. Only explicit
**Mark as read** or **Mark as done** actions send notification updates; visiting a
linked GitHub page may also mark a notification read on GitHub.

## Documentation

- [Usage](docs/usage.md): browsing, filtering, Read/Done actions, and keyboard controls.
- [Installation](docs/installation.md): setup, updates, and verification.
- [Settings](docs/settings.md): preferences, desktop alerts, and troubleshooting.
- [Development](docs/development.md): local development, tests, packaging, and releases.
- [Agent guidance](AGENTS.md): repository conventions, invariants, and validation.
