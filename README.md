# Unread Notifications

Unread GitHub notifications in the GitHub Copilot app, grouped by repository.
Search, mark rows or repositories as read, and opt into sound or auto-open.

![Unread Notifications canvas showing a repository group, search, settings, and mark-as-read controls](docs/images/unread-notifications.png)

## Prerequisites

- A GitHub Copilot app build with extension canvas support (experimental).
- Node.js 22 or later.
- [GitHub CLI](https://cli.github.com/) (`gh`) available to the app and signed
  into **github.com** with `notifications` or `repo` scope.

GitHub.com only; fine-grained personal access tokens are not supported.
Check sign-in with `gh auth status --hostname github.com`.

<a id="installation"></a>
<a id="updating"></a>

## Installation and Updating

### Install or update with Copilot

Use the same prompt for a fresh installation or an upgrade, including versions
that do not yet have an update banner:

```text
Install or update the Unread Notifications canvas from
https://github.com/fletchto99/copilot-notifications-canvas as a user-wide
GitHub Copilot extension available across sessions. Follow the repository's
manual steps under "Installation and Updating".

Use the latest published stable GitHub Release, not main or a prerelease.
If no stable release exists, stop and report that. If already current, report
that instead of reinstalling. Do not downgrade a newer installed version.

Read the release notes, fetch the exact release tag into a separate clean
checkout or worktree, and run node scripts/check-release.mjs <release-tag>
before node scripts/install.mjs. Use my existing COPILOT_HOME and GitHub CLI
sign-in.

Preserve the entire installed artifacts directory in place, including
settings.json, autoOpen, darkMode, unknown settings, and other files. Do not
delete or recreate that directory, overwrite locally modified runtime files,
or bypass installer safeguards. Report missing prerequisites or permissions
without changing credentials.

Only after installation succeeds, reload extensions in this session and
open Unread Notifications (canvasId: github-notifications). Report the
installed version and remind me to reload extensions in other already-open
sessions. Do not enable auto-update or change any preferences.
```

### Manual installation and updates

Both paths install user-wide into
`${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications`.
Use the same `COPILOT_HOME` for an upgrade as for the original installation.

1. Read the [release notes](https://github.com/fletchto99/copilot-notifications-canvas/releases)
   and choose the latest stable `<release-tag>`. If no stable release is
   published yet, wait for the first release or use a development checkout
   explicitly.
2. Enter your existing repository clone. If you do not have one, create it
   in the directory where you keep repositories:

   ```sh
   git clone https://github.com/fletchto99/copilot-notifications-canvas
   cd copilot-notifications-canvas
   ```

3. From that clone, run the following with a **new, unused worktree path**.
   Set `COPILOT_HOME` first if you use a custom location:

   ```sh
   git fetch origin tag <release-tag>
   git worktree add --detach ../copilot-notifications-release <release-tag>
   cd ../copilot-notifications-release
   node scripts/check-release.mjs <release-tag>
   node scripts/install.mjs
   ```

4. Only after the installer succeeds, ask Copilot:

   > Reload extensions, then open the Unread Notifications canvas.

   Other already-open Copilot sessions need their own extension reload.

**Settings are preserved.** The installer updates only managed runtime files.
It leaves `artifacts/` in place, including `artifacts/settings.json`, unknown
settings, and other artifacts, even if a running session saves settings during
the update. Never delete the installed extension to upgrade it. If the installer
reports modified files, stop and preserve those changes; do not bypass its
ownership or concurrency safeguards.

Updates use the user-wide installer. A project-local checkout shadows a
user-wide installation in that repository; update that checkout deliberately
instead of expecting a user-wide install to replace it. Sound is intentionally
per-panel, so a reload resets sound to off; persisted settings such as
**Auto-open** and **Dark mode** are retained.

## Usage

- Repository groups are always sorted alphabetically by full name (`owner/repo`),
  so marking notifications as read does not reorder the remaining groups.
  Notifications within each group remain newest first.
- The canvas loads up to 50 notifications initially. **Load more** fetches up to
  50 more at a time, with no fixed total cap while GitHub has more pages.
  Search covers loaded notifications only.
- Notifications refresh about every two minutes while the canvas is visible.
  GitHub polling and rate limits can delay updates.
- **Force refresh**, beside the checked time in the footer, checks loaded pages
  immediately without waiting for the polling interval. It stays clickable;
  clicks during an active operation queue one follow-up refresh. GitHub
  rate-limit and error retry waits still apply and are shown as errors.
- The **Settings** gear icon includes matching **Dark mode**, **Auto-open**, and
  **Play sound** switches. The canvas follows Copilot's theme until you choose
  light or dark; your choice is saved across sessions and loaded when a panel
  opens or becomes visible.
- **Auto-open** and **Play sound** are off by default. Sound is per-panel and
  resets when the panel reloads or reopens.
- Auto-open runs once per new session, including general chats, before assistant
  work starts. Other canvases do not block it. It does not reopen Notifications
  on session resume, extension reload, or after you close the panel.
- A repository's **Mark N as read** immediately starts marking only its shown,
  loaded notifications, narrowed by search. Older unloaded items are not included.

## Privacy

Notification content stays in local memory. It is not logged, saved to disk, or
sent to the agent. GitHub CLI handles credentials; they never enter the canvas
renderer. There is no telemetry or remote asset loading.

The extension fetches notifications and public release metadata from GitHub
through GitHub CLI. Release checks do not send notification content or download
or execute release code. Only explicit row or repository
**Mark as read** clicks send read updates. Visiting a linked GitHub page may also
mark that notification read on GitHub.

## Development

Runtime files are in `.github/extensions/github-notifications/`. Open this
repository as a Copilot project to work on its local extension. After edits,
reload extensions and use extension **list/inspect** to check the provider and
its log.

Run the tests:

```sh
node --test test/*.test.mjs
```

The [test workflow](.github/workflows/tests.yml) runs the same suite on pull
requests and pushes to `main`. Tests use synthetic fixtures and need no dependency
installation, GitHub sign-in, or external network access.

### Publishing releases

Use stable semantic versions (`vMAJOR.MINOR.PATCH`) so users receive deliberate,
tested updates with release notes instead of every merge. Bump
`.github/extensions/github-notifications/version.json` in the release PR.

After merging the version change into `main`, invoke the
[Release workflow](.github/workflows/release.yml) from **Actions → Release →
Run workflow**. Select **main** and enter either the version (`0.1.1`) or its
tag (`v0.1.1`). Both are validated and normalized to `v0.1.1` before publication.
The workflow must be merged into the default branch before GitHub
offers the manual trigger.

You can also invoke it with GitHub CLI:

```sh
gh workflow run release.yml \
  --repo fletchto99/copilot-notifications-canvas \
  --ref main \
  -f version=0.1.1
```

The workflow checks that the requested version matches `version.json`, runs
the full test suite, creates the matching tag at the **exact tested commit**,
and publishes a GitHub Release with generated notes. It does not bump the
version or commit changes to `main`. Manual runs from other branches are
rejected. Publication is serialized across manual runs and tag pushes.

If publication fails after creating the tag, rerun the failed job: a tag
already pointing to the tested commit can be reused. A tag pointing elsewhere
is rejected, never moved. An existing release is never overwritten. If tag
rules block creation, fix the repository permissions or create the tag yourself;
do not bypass the rules.

Pushing a matching release tag yourself still invokes the same validation,
tests, and publication. After a successful run, review the generated notes for
behavior changes, prerequisites, and update guidance. Confirm GitHub marks the
intended stable version as **Latest**; the canvas follows `/releases/latest`.

Publish increasing versions; never move a published tag or reuse a version.
For a bad release, publish a fixed version rather than modifying existing
release code. Restrict `v*` tag creation with repository rules if more
contributors gain write access.

Existing installations from before the update banner need one manual update
to a release containing this feature. They cannot discover updates retroactively.
