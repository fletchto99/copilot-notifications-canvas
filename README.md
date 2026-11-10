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
or groups as read or done, start a focused Copilot investigation, review, or discussion summary,
and opt into desktop notifications or auto-open.

![GitHub Notifications canvas with search and attention tabs including Mine, italic mine markers on authored items among ten synthetic notifications, seven unread, across three example repositories, issue, PR and discussion status icons, a failed check run, and fixed Copilot, read, and done columns with summary actions on closed issues, discussions, merged PRs, and releases, a disabled Copilot icon on queued PRs, and dimmed envelopes on already-read rows](docs/images/github-notifications.png)

## Prerequisites

- A GitHub Copilot app build with extension canvas support (experimental).
- Node.js 22 or later for the extension runtime and installer.
- [GitHub CLI](https://cli.github.com/) (`gh`) available to the app and signed
  into **github.com** with `notifications` or `repo` scope.
- Copilot PR, CI, and commit handoffs also require Git 2.29 or later and the configured
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

- **Find:** Filter with attention tabs or search by title, issue/PR number, or
  repository. **Mine** shows issues, PRs, and discussions you authored.
- **Choose a view:** In **Settings**, group by repository or date, or use one
  flat list. Show all inbox items or unread only.
- **Read or done:** Use the envelope to mark read or the checkmark to mark done.
  Group headers offer the same actions for loaded tab/search matches.
- **Work with Copilot:** Investigate, review, continue, or summarize a supported
  item. New sessions summarize first and stay read-only until you approve changes;
  existing sessions open without interruption.
- **Use the keyboard:** **J/K** moves between rows, **Enter** opens a focused link,
  **I** marks read, **Shift+E** marks done, **/** focuses search, and **?** shows shortcuts.
- **Load more:** Include older notifications. Search, counts, and bulk actions
  cover **loaded items only**, not your entire inbox.

See [Usage](docs/usage.md) for status icons and controls,
[Copilot actions](docs/copilot.md) for supported tasks and confirmations, and
[Settings](docs/settings.md) for preferences and opt-in desktop alerts.

## Privacy

- **Inbox content:** Notification titles and repository names are not logged or
  saved to the extension's files. Ordinary agent actions return counts, not content.
  There is no telemetry or remote asset loading.
- **Copilot handoffs:** The extension sends only the selected GitHub reference and
  task instructions, not notification titles, bodies, or the surrounding inbox.
  The reference, instructions, and item details fetched by the destination session
  are retained in Copilot's session history.
- **Confirmations:** Handoffs require a row click; confirmation is on by default. Cloning,
  inferred CI matches, and existing/new session choices always require confirmation.
- **Desktop alerts:** Opt-in alerts share repository names and titles with your OS,
  which may retain them or show them on the lock screen. Windows also receives a
  validated GitHub destination URL.
- **Local data:** `artifacts/` stores settings and desktop coordination data,
  including timestamps, hashed IDs, process markers, and sanitized errors.
  Status and authorship are cached only in memory.
- **Credentials and updates:** GitHub CLI handles authentication; credentials never
  enter the renderer. Update checks send no notification content and never download
  or execute release code.
- **Read/done state:** Only explicit Read/Done actions send notification updates.
  Visiting a linked GitHub page may also mark it read on GitHub.

## Documentation

- [Usage](docs/usage.md): browsing, filtering, Read/Done actions, and keyboard controls.
- [Copilot actions](docs/copilot.md): prompts by notification type, confirmations, and session safeguards.
- [Installation](docs/installation.md): setup, updates, and verification.
- [Settings](docs/settings.md): preferences, desktop alerts, and troubleshooting.
- [Development](docs/development.md): local development, tests, packaging, and releases.
- [Agent guidance](AGENTS.md): repository conventions, invariants, and validation.
