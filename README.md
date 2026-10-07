# Unread Notifications

Unread GitHub notifications in the GitHub Copilot app, grouped by repository or
date, or shown as a single newest-first list.
Search, mark rows or repositories as read, and opt into desktop
notifications or auto-open.

![Unread Notifications canvas showing a repository group, search, settings, and mark-as-read controls](docs/images/unread-notifications.png)

## Prerequisites

- A GitHub Copilot app build with extension canvas support (experimental).
- Node.js 22 or later.
- [GitHub CLI](https://cli.github.com/) (`gh`) available to the app and signed
  into **github.com** with `notifications` or `repo` scope. Installation requires
  a version supporting `gh release verify`, `gh release verify-asset`, and
  `gh attestation verify` with all identity-policy flags shown below.

GitHub.com only; fine-grained personal access tokens are not supported.
Check sign-in with `gh auth status --hostname github.com`.

<a id="installation"></a>
<a id="updating"></a>

## Installation and Updating

### Install or update with Copilot

Use the same prompt for a fresh installation or a packaged-release upgrade:

```text
Install or update the Unread Notifications canvas from
https://github.com/fletchto99/copilot-notifications-canvas as a user-wide
GitHub Copilot extension available across sessions. Follow the repository's
manual steps under "Installation and Updating".

Use the latest published stable GitHub Release, not main or a prerelease.
If no stable release exists, stop and report that. If already current, report
that instead of reinstalling. Do not downgrade a newer installed version.

Read the release notes and download github-notifications-<release-tag>.tar.gz
and SHA256SUMS from that exact release. Before extracting or executing anything,
follow the manual gh release verify, gh release verify-asset, and
gh attestation verify commands without omitting flags. Require this repository's
.github/workflows/release.yml, refs/tags/<release-tag>, and the tag's resolved
commit for both source and signer digests. Reject self-hosted runners and require
https://slsa.dev/provenance/v1. Resolve annotated tags to commits, not tag objects.
After all checks, including SHA256SUMS, pass, extract into a new directory and
run node install.mjs <release-tag>. Use my existing COPILOT_HOME and GitHub CLI sign-in.
Stop if packages, attestations, or verification capabilities are missing or any
check fails; do not fall back to source or checksum-only verification.

Preserve the entire installed artifacts directory in place, including
settings.json, autoOpen, darkMode, groupBy, unknown settings, and other files. Do not
delete or recreate that directory, overwrite locally modified runtime files,
or bypass installer safeguards. Report missing prerequisites or permissions
without changing credentials.

If a legacy/source installation is detected, stop and report the repository's
one-time migration instructions. Do not migrate it while old extension
processes may be running.

Only after installation succeeds, reload extensions in this session and
open Unread Notifications (canvasId: github-notifications). Report the
installed version and remind me to reload extensions in other already-open
sessions. Do not enable auto-update or change any preferences.
```

### Manual installation and updates

Packaged releases (starting with **v0.2.0**) install user-wide into
`${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications`.
Use the same `COPILOT_HOME` for an upgrade as for the original installation.

1. Read the [release notes](https://github.com/fletchto99/copilot-notifications-canvas/releases)
   and choose the latest stable `<release-tag>`. If no stable release is
   published with the package assets yet, stop. GitHub's automatically
   generated **Source code** downloads are not installation packages.
2. Download into a **new, unused directory** and verify before extracting.
   Set `COPILOT_HOME` first if you use a custom location. Replace the example
   tag below with your chosen stable release:

   ```sh
   tag=v0.2.0
   mkdir github-notifications-release &&
   cd github-notifications-release &&
   gh release verify "$tag" \
     --repo fletchto99/copilot-notifications-canvas &&
   gh release download "$tag" \
     --repo fletchto99/copilot-notifications-canvas \
     --pattern "github-notifications-$tag.tar.gz" --pattern SHA256SUMS &&
   gh release verify-asset "$tag" "github-notifications-$tag.tar.gz" \
     --repo fletchto99/copilot-notifications-canvas &&
   commit=$(gh api --hostname github.com \
     "repos/fletchto99/copilot-notifications-canvas/commits/$tag" --jq .sha) &&
   printf '%s\n' "$commit" | grep -Eq '^[0-9a-f]{40}$' &&
   gh attestation verify "github-notifications-$tag.tar.gz" \
     --repo fletchto99/copilot-notifications-canvas --hostname github.com \
     --signer-workflow fletchto99/copilot-notifications-canvas/.github/workflows/release.yml \
     --source-ref "refs/tags/$tag" --source-digest "$commit" \
     --signer-digest "$commit" --deny-self-hosted-runners \
     --predicate-type https://slsa.dev/provenance/v1 &&
   sha256sum -c SHA256SUMS &&
   mkdir package &&
   tar -xzf "github-notifications-$tag.tar.gz" -C package &&
   cd package &&
   node install.mjs "$tag"
   ```

   On macOS, replace `sha256sum -c SHA256SUMS` with
   `shasum -a 256 -c SHA256SUMS`. These are shell commands; on Windows, use
   a shell with `tar` and a SHA-256 utility, or verify with PowerShell's
   `Get-FileHash -Algorithm SHA256` before extracting. Never continue after
   a failed download, commit resolution, release/provenance verification, or
   checksum check. Missing attestations or unsupported verification flags are
   errors, not reasons to skip a check.

   Release verification binds the archive to an immutable release. Build
   provenance binds its digest to this repository's workflow, tag and commit
   on a GitHub-hosted runner, using certificate identity. The commits API
   resolves annotated tags to **commits**, not tag objects. Both checks are
   required; neither proves that the software is safe.

   The archive contains only `extension.mjs`, `install.mjs`, and `release.json`.
   No clone, npm install, build tools, or separately installed Copilot SDK
   are needed. The installer also verifies the package's file hashes and
   version, refuses downgrades, and does nothing if already current.

3. Only after the installer succeeds, ask Copilot:

   > Reload extensions, then open the Unread Notifications canvas.

   Other already-open Copilot sessions need their own extension reload.

**Settings are preserved.** The installed layout is one self-contained
`extension.mjs` beside `artifacts/`. HTML, minified browser JavaScript and CSS,
provider code, version, and ownership metadata are all in that bundle. The
Copilot SDK remains host-provided. Upgrades stage and verify the replacement,
then activate it with one atomic file rename. There is no separate installed
manifest to get out of sync and no accumulating runtime directories.

It leaves `artifacts/` in place, including `artifacts/settings.json`, unknown
settings, and other artifacts, even if a running session saves settings during
the update. Never delete the installed extension to upgrade it. If the installer
reports modified files, stop and preserve those changes; do not bypass its
ownership or concurrency safeguards.

Already-running packaged providers retain their own loaded code and embedded
assets, including when opening another panel after an upgrade. They need an
extension reload to pick up the new version. An error before activation leaves
the previous bundle intact; an interruption after activation leaves a complete
new bundle. A retry recognizes whichever version is installed.

Updates use the user-wide installer. A project-local checkout shadows a
user-wide installation in that repository; update that checkout deliberately
instead of expecting a user-wide install to replace it. Persisted settings,
including **Group By**, **Theme**, **Auto-open**, **Desktop notifications** and
**Sound**, are retained.

### One-time migration from source installations

The first packaged release is a new baseline, not an in-place upgrade for the
old flat-file or `runtimes/<hash>/` layouts. The installer deliberately refuses
those layouts rather than deleting code that an old session might still need.

1. Stop **all** Copilot app/CLI sessions and extension processes using the old
   installation. Closing a canvas or reloading only one session is not enough.
   Perform the migration from an external terminal after they have stopped.
2. Locate `${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications`.
   Make a backup outside every extension discovery directory. Move its old
   code and metadata into that backup, including retained `runtimes/`, but
   **leave `artifacts/` exactly where it is**. Preserve locally modified files
   in the backup; do not delete or overwrite them. The installation directory
   should now contain only `artifacts/` (or be empty).
3. While all old extension processes are still stopped, check the testing-era
   data in `artifacts/`:
   - If `desktop-state.json` uses schema version **1**, move just that file to
     the backup. The next enabled desktop poll creates a current version **2**
     checkpoint and establishes a silent baseline. Leave a valid version 2
     checkpoint untouched; its schema version is independent of the release version.
   - If `settings.json` has a boolean `desktopSound`, back up that file and
     explicitly change `true` to `"default"` or `false` to `"none"`. Preserve
     every other setting and unknown key. Missing sound preferences already
     default to `"default"`; valid string values need no changes.
   - Leave all other artifacts in place. Unexpected or malformed data requires
     inspection, not a blanket reset.
4. Install the verified release package using the steps above, restart Copilot,
   and open the canvas. Keep the backup until you have confirmed the new
   installation and settings. Future packaged updates need no such migration.

The runtime accepts only current checkpoint and sound formats. It reports
invalid stored data rather than migrating or overwriting it automatically.

## Usage

- **Browse and search:** loads up to 50 notifications at a time; **Load more**
  continues while GitHub has more pages. Search and counts cover loaded items only.
- **Mark as read:** mark individual rows in any view. In **repo** mode,
  **Mark N as read** marks only that repository's loaded items matching your search,
  not older unloaded notifications.
- **Refresh:** automatic checks run about every two minutes while visible.
  **Force refresh** in the footer checks loaded pages without waiting for that
  interval; GitHub rate limits and error retry waits still apply.
- **Open GitHub:** the inbox icon beside **Settings** opens your
  [GitHub inbox](https://github.com/notifications).

Settings are saved across sessions:

| Setting | Options |
| --- | --- |
| **Group By** | **repo** (default): alphabetical repositories, newest items first. **none**: one newest-first list. **date**: newest local calendar day first. All use last-updated times. |
| **Theme** | **System** (default), **Dark**, or **Light**. System follows Copilot, falling back to the OS theme. |
| **Auto-open** | Off by default. Opens once per new session, including general chats; not on resume, reload, or after closing the panel. |
| **Desktop notifications** | Off by default. Enable native alerts as described below. |
| **Sound** | System-specific sounds; defaults to **System default**. |

If local UI files fail to load, the recovery page retries automatically. For
persistent failures, reload extensions or reinstall while preserving settings.

### Desktop notifications

Enable **Desktop notifications** in Settings and choose a **Sound**.
Alerts continue while the panel is hidden or Copilot is minimized, provided its
session's extension process is running. Closing the last Notifications canvas
or quitting Copilot stops them. No extra software is installed automatically.

| Platform | Requirements | Sounds |
| --- | --- | --- |
| macOS | Built-in `osascript`; allow notifications for the script sender. | System default or named sounds such as Glass, Ping and Submarine. |
| Windows 10/11 | Built-in Windows PowerShell/WinRT, PowerShell's existing Start menu registration, and an interactive desktop. | Default, IM, Mail, Reminder and SMS. |
| Linux | `notify-send` (libnotify) and a graphical D-Bus notification service. | Default or themed sound hints; desktops may ignore sound or silence hints. |

Windows and Linux support is experimental. Alerts run on the **extension host**;
remote sessions do not automatically notify your local computer.

Checks run about every two minutes, subject to GitHub limits and independent of
search or loaded pages. For each repository, **1-4 new or updated unread threads**
produce individual alerts with the repository name and notification title.
**5 or more in one poll** produce a single `<count> new notifications` summary
with one sound request. Counts reflect new activity, not the whole unread inbox.

The first successful poll after enabling or restarting all watchers is silent,
so existing unread items do not trigger alerts. GitHub reports only the latest
activity per thread, not every event between polls.

Sessions sharing a local `COPILOT_HOME` coordinate to avoid duplicate alerts;
separate machines or homes do not. Delivery is **at most once**: failed or
interrupted batches are not replayed, so alerts can be lost. Reload older
sessions after upgrades; a changed checkpoint format starts a fresh silent baseline.

OS permissions, sound settings and Focus/Do Not Disturb can suppress delivery,
which the extension cannot confirm. Detected errors appear in Settings and the
extension log. The OS controls the sender icon; clicking an alert cannot focus
the canvas.

## Privacy

The extension does not log notification titles or repository names, save them to
disk, or send them to the agent. There is no telemetry or remote asset loading.

**Desktop alerts send repository names and titles to your OS**, which may retain
them in notification history or show them on the lock screen. System settings
control this, not the extension.

The local `artifacts/` directory stores settings and desktop coordination data:
timestamps, hashed activity/thread IDs, watcher/process markers and sanitized
errors. GitHub CLI handles credentials; they never enter the canvas renderer.

GitHub CLI fetches notifications and public release metadata. Update checks do
not send notification content or download or execute release code. Only explicit
**Mark as read** actions send read updates; visiting a linked GitHub page may
also mark a notification read on GitHub.

## Development

Provider modules and renderer assets live in `src/`. The one-line entry point
at `.github/extensions/github-notifications/extension.mjs` imports
`src/extension.mjs`, so opening this repository as a Copilot project loads the
local source directly without a build. After edits, reload extensions and use
extension **list/inspect** to check the provider and its log.
Each session uses its own checkout and loaded asset snapshot; do not delete a
checkout while a session uses it. If both project and user providers are
registered, pass `extensionId: project:github-notifications` when opening the
local canvas.

Release builds also start from `src/extension.mjs`, not the development entry
point. The installer still writes only the bundled `extension.mjs` under the
user-wide `extensions/github-notifications/` directory.

Unit and HTTP integration tests need no dependency installation:

```sh
node --test test/*.test.mjs
```

For lint, coverage and browser checks:

```sh
npm ci --ignore-scripts
npm run lint
npm run lint:workflows  # Requires actionlint on PATH.
npm run test:coverage
npx playwright install --with-deps chromium webkit
npm run test:browser
```

Coverage also works without `npm ci`. Playwright downloads browser binaries and
may need permission to install Linux system libraries. Use `-- --project=webkit`
with `npm run test:browser` to run one engine.

The [test workflow](.github/workflows/tests.yml) defines the platform matrix,
coverage thresholds, lint and Chromium/WebKit accessibility checks. Tests use
synthetic GitHub responses and isolated settings: no sign-in, live read updates,
or OS notifications. SDK stubs do not verify compatibility with a specific
Copilot build; reload and inspect the real extension after SDK changes.
Development dependencies are not included in installed extensions.

Ordinary CI does not build or publish release assets. To validate packaging
locally (not to distribute a development installation):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build -- v0.2.0
npm run test:package
```

Use the tag matching the repository-root `version.json`. The pinned bundling
and archive dependencies are build-time only. Generated output goes in ignored
`dist/`, not Git. Archives use a fixed file order, permissions, and normalized
ownership/timestamps; tests compare repeated builds byte-for-byte. Reproduction
assumes the same source and toolchain, not arbitrary compiler/runtime versions.
Package tests also install into temporary Copilot homes and load a stub host SDK.

### Publishing releases

Use stable semantic versions (`vMAJOR.MINOR.PATCH`) so users receive deliberate,
tested updates with release notes instead of every merge. Bump
the repository-root `version.json` in the release PR. This is the single source
of truth for the release version; `package.json` only describes development tooling.

After merging the version change into protected `main`, tag that exact commit and push
the tag. For example, from an up-to-date checkout of the intended release commit:

```sh
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

Only `v*` tag pushes trigger the [Release workflow](.github/workflows/release.yml).
It validates the version and `main` ancestry, runs all PR checks, then builds,
tests and attests the exact archive with SHA-pinned `actions/attest`.
The build job has `contents: read`, `attestations: write` and `id-token: write`.
Only the separate publisher gets `contents: write`, plus `attestations: read`.
It downloads the exact Actions artifact by ID, rejects digest mismatches, and
never installs build dependencies or executes the package.

Before creating a release, the publisher rechecks the tag's tested commit and
`main` ancestry, rejects existing releases or drafts, and enforces the installation
provenance policy. Missing or failed verification stops publication.
`SHA256SUMS` must match the attested archive's digest and filename.
The workflow never creates or moves tags, bumps versions, or commits build output.

Publishing is serialized. GitHub CLI creates a draft, uploads the archive and
`SHA256SUMS`, then publishes that exact release by ID as **Latest**.
The job verifies the immutable release and both assets before reporting success.
Review the generated release notes for behavior changes and update guidance.

Repository settings must keep **release immutability enabled**. The configured
`v*` tag rules allow creation only by the release maintainer and block updates
and deletion without bypasses. Existing branch protections remain in place.
These settings are separate from the workflow and must be configured again
for a fork. Immutability affects future releases, not older mutable releases.
Provenance signing shares the build job; this is not an isolated trusted builder
or SLSA Build Level 3. Real signing requires a release-tag run; local builds are
not attested release packages.

An existing release or asset is never overwritten. A failure before draft
creation can be retried. If an upload/publication failure leaves a draft,
inspect it first; remove only that incomplete draft (not its tag) before
rerunning the job. Never replace assets on an already-published release.

Publish increasing versions; never move a published tag or reuse a version.
For a bad release, publish a fixed version rather than modifying existing
release code. Keep release-tag creation limited to authorized maintainers.

Installations from before the update banner cannot discover releases
retroactively. Follow the one-time source migration above rather than their
old source-based installation instructions.
