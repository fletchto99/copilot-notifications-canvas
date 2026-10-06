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

## Installation

### Install with Copilot

Have Copilot install this extension for you with this prompt:

```text
Install the Unread Notifications canvas from
https://github.com/fletchto99/copilot-notifications-canvas as a user-wide
GitHub Copilot extension available across sessions. Follow the repository's
manual "Install for all projects" steps using node scripts/install.mjs.
Install the latest stable GitHub Release, not the tip of main. If there is
no stable release yet, stop and report that instead of installing a development build.
Preserve existing settings and do not overwrite locally modified files or
bypass installer safeguards. Use my existing GitHub CLI sign-in; report
missing prerequisites or permissions without changing credentials. After
installation succeeds, reload extensions and open Unread Notifications
(canvasId: github-notifications).
```

### Install for all projects

Manual alternative, from the directory where you keep repositories. Use the
latest stable tag from [Releases](https://github.com/fletchto99/copilot-notifications-canvas/releases)
as `<release-tag>` below. If no stable release is published yet, wait for the
first release or use a development checkout explicitly.

```sh
git clone https://github.com/fletchto99/copilot-notifications-canvas
cd copilot-notifications-canvas
git fetch origin tag <release-tag>
git worktree add --detach ../copilot-notifications-release <release-tag>
cd ../copilot-notifications-release
node scripts/check-release.mjs <release-tag>
node scripts/install.mjs
```

Installs user-wide into `${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications`.
Upgrades preserve settings and refuse to overwrite modified or unrelated files.

After installation finishes, ask Copilot:

> Reload extensions, then open the Unread Notifications canvas.

## Updating

The canvas checks GitHub's **latest stable release**, not commits on `main`.
When a newer version is available, a small banner offers **Release notes**,
**Update instructions**, and **Copy update prompt**. Paste the prompt into
Copilot to perform the update; copying it does not execute anything. The prompt
is also selectable in the banner if clipboard access is unavailable.

**Settings** shows a **Check for updates** button with the running canvas version
directly below it.
Checks happen while the canvas is visible and are cached for six hours per
running extension, shared by its panels. A manual check can bypass this cache
at most once a minute, but never GitHub's retry delay. Failed checks retry
automatically after at least 30 minutes, do not block the inbox, and show an
error in Settings. Drafts, prereleases, and unsupported tag formats are never
offered. A build newer than the latest release is not downgraded.

To update manually:

1. Read the release notes and choose the exact stable `<release-tag>`.
2. From your existing repository clone, run the following with a **new,
   unused worktree path**. Set `COPILOT_HOME` to the same value used for the
   original installation, if customized, before running the installer:

   ```sh
   git fetch origin tag <release-tag>
   git worktree add --detach ../copilot-notifications-update <release-tag>
   cd ../copilot-notifications-update
   node scripts/check-release.mjs <release-tag>
   node scripts/install.mjs
   ```

3. Only after the installer succeeds, reload extensions and reopen the canvas.
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

There is no automatic installation or auto-update setting. Installation and
reload remain explicit. A future opt-in updater should be off by default,
reuse these installer safeguards, and coordinate activation across sessions.

## Usage

- Notifications refresh about every two minutes while the canvas is visible.
  GitHub polling and rate limits can delay updates.
- The **Settings** gear icon includes a sliding **Dark mode** switch. The canvas
  follows Copilot's theme until you choose light or dark; your choice is saved
  across sessions and loaded when a panel opens or becomes visible.
- Settings also includes an **Auto-open** slider above **Play sound**; both are off by default.
  Sound is per-panel and resets when the panel reloads or reopens.
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
The initial version is `0.1.0`; it is not available to users until a release
is actually published.

After merging the version change into `main`, invoke the
[Release workflow](.github/workflows/release.yml) from **Actions → Release →
Run workflow**. Select **main** and enter either the version (`0.1.0`) or its
tag (`v0.1.0`). Both are validated and normalized to `v0.1.0` before publication.
The workflow must be merged into the default branch before GitHub
offers the manual trigger.

You can also invoke it with GitHub CLI:

```sh
gh workflow run release.yml \
  --repo fletchto99/copilot-notifications-canvas \
  --ref main \
  -f version=0.1.0
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
