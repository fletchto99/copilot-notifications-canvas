# Installation and updating

[README](../README.md) | [Settings](Settings.md) | [Development](Development.md)

## Prerequisites

- A GitHub Copilot app build with extension canvas support (experimental).
- Node.js 22 or later.
- [GitHub CLI](https://cli.github.com/) (`gh`) available to the app and signed
  into **github.com** with `notifications` or `repo` scope. It must support
  `gh release verify`, `gh release verify-asset`, and `gh attestation verify`
  with every identity-policy flag in the commands below.

GitHub.com only; fine-grained personal access tokens are not supported.
Check sign-in with `gh auth status --hostname github.com`.

## Install or update with Copilot

Use this prompt for a fresh installation or a packaged-release upgrade:

```text
Install or update the Unread Notifications canvas from
https://github.com/fletchto99/copilot-notifications-canvas as a user-wide
GitHub Copilot extension available across sessions. Follow the repository's
docs/Installation.md for the complete manual steps.

Use the latest published stable GitHub Release, not main or a prerelease.
If no stable release exists, stop and report that. If already current, report
that instead of reinstalling. Do not downgrade a newer installed version.

Read the release notes and download github-notifications-<release-tag>.tar.gz
and SHA256SUMS from that exact release. Before extracting or executing anything,
follow the manual gh release verify, gh release verify-asset, and
gh attestation verify commands without omitting flags.
Pin the exact certificate identity to this repository's
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

## Manual installation and updates

Packaged releases (starting with **v0.2.0**) install user-wide into
`${COPILOT_HOME:-$HOME/.copilot}/extensions/github-notifications`.
Use the same `COPILOT_HOME` for an upgrade as for the original installation.

1. Read the [release notes](https://github.com/fletchto99/copilot-notifications-canvas/releases)
   and choose the latest stable `<release-tag>`. If no stable release has
   package assets, stop. GitHub's **Source code** downloads are not installation
   packages.
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
     --cert-identity "https://github.com/fletchto99/copilot-notifications-canvas/.github/workflows/release.yml@refs/tags/$tag" \
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
   `shasum -a 256 -c SHA256SUMS`. On Windows, use a shell with `tar` and a
   SHA-256 utility, or verify with PowerShell's `Get-FileHash -Algorithm SHA256`
   before extracting. Never continue after a failed check. Missing attestations
   or unsupported verification flags are errors, not reasons to skip verification.

   Release verification binds the archive to an immutable release. Build
   provenance binds it to this repository's workflow, tag, and resolved commit
   on a GitHub-hosted runner. Both checks are required; neither proves that the
   software is safe.

3. Only after the installer succeeds, ask Copilot:

   > Reload extensions, then open the Unread Notifications canvas.

   Other already-open Copilot sessions need their own extension reload.

## Upgrades and troubleshooting

The archive contains only `extension.mjs`, `install.mjs`, and `release.json`.
No clone, npm install, build tools, or separately installed Copilot SDK are
needed. The installer verifies file hashes and the version, refuses downgrades,
and does nothing if already current.

**Settings are preserved.** Upgrades replace the bundled `extension.mjs` while
leaving the entire `artifacts/` directory in place, including `settings.json`,
unknown settings, and other files, even during concurrent settings saves.
Never delete the installed extension to upgrade it. If the installer reports
modified files or a concurrency conflict, stop; do not bypass its safeguards.

Already-running providers retain their loaded code and assets until reloaded.
If local UI files fail to load, the recovery page retries automatically. For
persistent failures, reload extensions or reinstall while preserving settings.
See [Settings](Settings.md#troubleshooting) for settings-save and desktop errors.

A project-local checkout shadows the user-wide installation in that repository.
Update that checkout deliberately; see [Development](Development.md#local-development).

## One-time migration from source installations

The first packaged release is a new baseline, not an in-place upgrade for the
old flat-file or `runtimes/<hash>/` layouts. The installer refuses those layouts
rather than deleting code an old session might still need. Installations from
before the update banner cannot discover releases retroactively; follow this
migration instead of their old source-based installation instructions.

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
