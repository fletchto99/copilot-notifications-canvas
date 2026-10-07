import metadata from "../version.json" with { type: "json" };
import { parseResponse, runGh } from "./github.mjs";
import { InboxError } from "./model.mjs";
import { compareVersions, versionParts } from "./version.mjs";

export { compareVersions, versionParts } from "./version.mjs";

export const CURRENT_VERSION = metadata.version;
export const REPOSITORY = "fletchto99/copilot-notifications-canvas";
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
export const CHECK_INTERVAL = 15 * 60 * 1000;

function updatePrompt(version) {
  return `Update my user-wide Unread Notifications canvas to v${version} from
${REPOSITORY_URL}.
Follow the repository's "Installation and Updating" instructions. Download
github-notifications-v${version}.tar.gz and SHA256SUMS from the exact stable
release v${version}. Verify the archive's SHA-256 before extracting it into a new
directory, then run node install.mjs v${version} with my existing COPILOT_HOME.
Use only the published package, not a source checkout, main, or a local build.
Stop if the package is missing or verification fails. Do not downgrade a newer
installed version; report an already-current installation without reinstalling.
Preserve the entire installed artifacts directory in place, including settings.json
and unknown settings. Do not delete or recreate it, overwrite locally modified
runtime files, or bypass installer safeguards. If a legacy/source installation is
detected, stop and report the one-time migration instructions; do not migrate it
while old extension processes may be running. Keep my existing GitHub CLI sign-in.
If installation succeeds, reload extensions in this session and reopen Unread
Notifications (canvasId: github-notifications). Report the installed version and
remind me to reload extensions in other already-open sessions. Do not enable
auto-update or change any preferences.`;
}

function rateLimitUntil(headers, now) {
  const retry = headers["retry-after"];
  const delay = /^\d+$/.test(retry ?? "") ? Number(retry) * 1000 : Date.parse(retry) - now;
  const reset = /^\d+$/.test(headers["x-ratelimit-reset"] ?? "") ? Number(headers["x-ratelimit-reset"]) * 1000 : 0;
  return Math.max(now + CHECK_INTERVAL, Number.isFinite(delay) ? now + delay : 0,
    Number.isFinite(reset) ? reset : 0);
}

export class Updates {
  constructor({ run = runGh, now = Date.now, version = CURRENT_VERSION, log = () => {} } = {}) {
    if (!versionParts(version)) throw new Error("Invalid installed notification version.");
    this.run = run;
    this.now = now;
    this.version = version;
    this.log = log;
    this.latestVersion = null;
    this.checkedAt = null;
    this.nextCheckAt = 0;
    this.canCheckAt = 0;
    this.error = null;
    this.pending = null;
    this.closed = false;
  }

  snapshot() {
    const comparison = this.latestVersion ? compareVersions(this.latestVersion, this.version) : null;
    const status = comparison === null ? this.checkedAt === null ? "unchecked" : "no_release" :
      comparison > 0 ? "available" : comparison === 0 ? "current" : "ahead";
    return {
      currentVersion: this.version,
      latestVersion: this.latestVersion,
      status,
      checking: Boolean(this.pending),
      checkedAt: this.checkedAt,
      nextCheckAt: this.nextCheckAt,
      canCheckAt: this.canCheckAt,
      error: this.error,
      releaseUrl: this.latestVersion ? `${REPOSITORY_URL}/releases/tag/v${this.latestVersion}` : null,
      instructionsUrl: `${REPOSITORY_URL}#installation-and-updating`,
      prompt: status === "available" ? updatePrompt(this.latestVersion) : null,
    };
  }

  check({ force = false } = {}) {
    if (this.pending) return this.pending;
    if (this.closed || this.now() < (force ? this.canCheckAt : this.nextCheckAt)) {
      return Promise.resolve(this.snapshot());
    }
    this.controller = new AbortController();
    this.pending = this.request(this.controller.signal)
      .finally(() => { this.pending = null; })
      .then(() => this.snapshot());
    return this.pending;
  }

  async request(signal) {
    try {
      const result = parseResponse(await this.run([
        "api", "--hostname", "github.com", "--include", "--method", "GET",
        "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28",
        `/repos/${REPOSITORY}/releases/latest`,
      ], { signal }));
      if (signal.aborted) return;
      if ([403, 429].includes(result.status)) {
        this.canCheckAt = rateLimitUntil(result.headers, this.now());
        throw new InboxError("update_rate_limit", "GitHub declined the release check. Check access or wait until the retry time.");
      }
      let latest = null;
      if (result.status === 200) {
        let release;
        try {
          release = JSON.parse(result.text);
        } catch {
          throw new InboxError("update_response", "GitHub returned unreadable release metadata.");
        }
        const tag = release?.tag_name;
        if (release?.draft !== false || release?.prerelease !== false || typeof tag !== "string" ||
            !tag.startsWith("v") || !versionParts(tag.slice(1))) {
          throw new InboxError("update_version", "The latest release does not have a supported stable vMAJOR.MINOR.PATCH tag.");
        }
        latest = tag.slice(1);
      } else if (result.status !== 404) {
        throw new InboxError("update_http", `Could not check releases (GitHub HTTP ${result.status}).`);
      }
      this.latestVersion = latest;
      this.checkedAt = this.now();
      this.nextCheckAt = this.now() + CHECK_INTERVAL;
      this.canCheckAt = 0;
      this.error = null;
    } catch (error) {
      if (signal.aborted) return;
      this.error = error instanceof InboxError ? error.message : "The release check failed. Inspect the extension log.";
      this.nextCheckAt = Math.max(this.now() + CHECK_INTERVAL, this.canCheckAt);
      this.log("Notification release check failed; the inbox is unaffected.", { level: "warning" });
    }
  }

  close() {
    this.closed = true;
    this.controller?.abort();
  }
}
