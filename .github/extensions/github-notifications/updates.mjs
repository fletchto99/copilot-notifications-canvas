import metadata from "./version.json" with { type: "json" };
import { parseResponse, runGh } from "./github.mjs";
import { InboxError } from "./model.mjs";

export const CURRENT_VERSION = metadata.version;
export const REPOSITORY = "fletchto99/copilot-notifications-canvas";
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
export const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL = 30 * 60 * 1000;

export function versionParts(version) {
  if (typeof version !== "string" || version.length > 64 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null;
  const parts = version.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) throw new Error("Expected stable major.minor.patch versions.");
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function updatePrompt(version) {
  return `Update my user-wide Unread Notifications canvas to v${version} from
${REPOSITORY_URL}.
Follow the repository's "Updating" instructions. Fetch the exact release tag
v${version} into a separate clean checkout or worktree and verify version.json
matches it before running node scripts/install.mjs with my existing COPILOT_HOME.
Preserve the entire installed artifacts directory in place, including settings.json
and unknown settings. Do not delete or recreate it, overwrite locally modified
runtime files, or bypass installer safeguards. Keep my existing GitHub CLI sign-in.
If installation succeeds, reload extensions in this session and reopen Unread
Notifications (canvasId: github-notifications). Report the installed version and
remind me to reload extensions in other already-open sessions. Do not enable
auto-update or change any preferences.`;
}

function rateLimitUntil(headers, now) {
  const retry = headers["retry-after"];
  const delay = /^\d+$/.test(retry ?? "") ? Number(retry) * 1000 : Date.parse(retry) - now;
  const reset = /^\d+$/.test(headers["x-ratelimit-reset"] ?? "") ? Number(headers["x-ratelimit-reset"]) * 1000 : 0;
  return Math.max(now + RETRY_INTERVAL, Number.isFinite(delay) ? now + delay : 0,
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
      instructionsUrl: `${REPOSITORY_URL}#updating`,
      prompt: status === "available" ? updatePrompt(this.latestVersion) : null,
    };
  }

  check({ force = false } = {}) {
    if (this.pending) return this.pending;
    if (this.closed || this.now() < (force ? this.canCheckAt : this.nextCheckAt)) {
      return Promise.resolve(this.snapshot());
    }
    this.canCheckAt = this.now() + 60_000;
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
      this.error = null;
    } catch (error) {
      if (signal.aborted) return;
      this.error = error instanceof InboxError ? error.message : "The release check failed. Inspect the extension log.";
      this.nextCheckAt = Math.max(this.now() + RETRY_INTERVAL, this.canCheckAt);
      this.log("Notification release check failed; the inbox is unaffected.", { level: "warning" });
    }
  }

  close() {
    this.closed = true;
    this.controller?.abort();
  }
}
