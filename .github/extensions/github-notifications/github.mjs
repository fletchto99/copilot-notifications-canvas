import { execFile } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { InboxError, normalizeThreads } from "./model.mjs";

export const POLL_MS = 120_000;
const API_ORIGIN = "https://api.github.com";

export function firstPage() {
  return "/notifications?all=false&per_page=50&page=1";
}

function endpointURL(endpoint) {
  let url;
  try {
    url = new URL(endpoint, API_ORIGIN);
  } catch {
    throw new InboxError("invalid_pagination", "GitHub returned an invalid pagination link.");
  }
  const keys = [...url.searchParams.keys()];
  if (url.origin !== API_ORIGIN || url.username || url.password || url.hash ||
      url.pathname !== "/notifications" || keys.length !== 3 ||
      !keys.every(key => ["all", "per_page", "page"].includes(key)) ||
      url.searchParams.get("all") !== "false" ||
      url.searchParams.get("per_page") !== "50" ||
      !/^[1-9]\d*$/.test(url.searchParams.get("page") ?? "") ||
      !Number.isSafeInteger(Number(url.searchParams.get("page")))) {
    throw new InboxError("invalid_pagination", "GitHub returned an unsafe or unsupported pagination link.");
  }
  url.searchParams.sort();
  return url;
}

export function nextPage(header, currentEndpoint) {
  if (!header) return null;
  const links = header.split(",");
  const next = links.filter(link => /;\s*rel="next"(?:\s*;|\s*$)/.test(link));
  if (!next.length) {
    if (links.some(link => !/^\s*<[^>]+>;\s*rel="(?:prev|first|last)"\s*$/.test(link))) {
      throw new InboxError("invalid_pagination", "GitHub returned an unreadable pagination header.");
    }
    return null;
  }
  const match = next.length === 1 && next[0].match(/^\s*<([^>]+)>;\s*rel="next"\s*$/);
  if (!match) throw new InboxError("invalid_pagination", "GitHub returned an unreadable next-page link.");
  const url = endpointURL(match[1]);
  const current = endpointURL(currentEndpoint);
  if (url.searchParams.get("all") !== current.searchParams.get("all") ||
      Number(url.searchParams.get("page")) !== Number(current.searchParams.get("page")) + 1) {
    throw new InboxError("invalid_pagination", "GitHub returned an inconsistent next-page link.");
  }
  return `${url.pathname}${url.search}`;
}

export function parseResponse(stdout) {
  if (typeof stdout !== "string") throw new InboxError("invalid_response", "No HTTP response from GitHub CLI.");
  const separator = /\r?\n\r?\n/.exec(stdout);
  if (!separator) throw new InboxError("invalid_response", "GitHub CLI returned an unreadable HTTP response.");
  const lines = stdout.slice(0, separator.index).split(/\r?\n/);
  const status = /^HTTP\/[\d.]+\s+(\d{3})(?:\s|$)/.exec(lines.shift());
  if (!status) throw new InboxError("invalid_response", "GitHub CLI returned an unreadable HTTP status.");
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new InboxError("invalid_response", "GitHub CLI returned malformed HTTP headers.");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const text = stdout.slice(separator.index + separator[0].length);
  return { status: Number(status[1]), headers, text };
}

export function runGh(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
    delete env.GH_DEBUG;
    delete env.DEBUG;
    execFile("gh", args, { env, signal, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (signal?.aborted) return reject(new InboxError("closed", "The canvas was closed.", 410));
        if (error.code === "ENOENT") {
          return reject(new InboxError("gh_missing", "Install GitHub CLI (gh), then restart the Copilot app.", 503));
        }
        if (error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return reject(new InboxError("gh_timeout", "GitHub CLI timed out or exceeded its response limit. Try again.", 504));
        }
        // gh exits nonzero on HTTP errors, but --include still supplies status and headers.
        if (/^HTTP\/[\d.]+\s+\d{3}/.test(stdout)) return resolve(stdout);
        if (/gh auth login|not logged|GH_TOKEN|authentication/i.test(stderr)) {
          return reject(new InboxError("authentication", "Sign in with gh auth login --hostname github.com. This view retries automatically while visible.", 401));
        }
        reject(new InboxError("gh_failed", "GitHub CLI could not reach GitHub. Check your connection and gh auth status.", 502));
      });
  });
}

function seconds(value) {
  return /^\d+$/.test(value ?? "") ? Number(value) * 1000 : 0;
}

export class GitHubClient {
  constructor({ run = runGh, now = Date.now, sleep = wait } = {}) {
    this.run = run;
    this.now = now;
    this.cache = new Map();
    this.queue = Promise.resolve();
    this.blockedUntil = 0;
    this.failures = new Map();
    this.lastError = null;
    this.sleep = sleep;
    this.writeAvailableAt = 0;
    this.pendingReads = new Set();
    this.readReservations = new Map();
    this.readListeners = new Set();
    this.revision = 0;
  }

  page(endpoint, signal, { force = false } = {}) {
    const url = endpointURL(endpoint);
    const path = `${url.pathname}${url.search}`;
    const pending = this.queue.then(() => this.request(path, signal, "GET", { force }));
    this.queue = pending.catch(() => {});
    return pending;
  }

  reserveReads(ids) {
    if (ids.some(id => this.pendingReads.has(id) || this.readReservations.has(id))) {
      throw new InboxError("busy", "A selected notification is already being marked as read in another operation.", 409);
    }
    const owner = Symbol("read batch");
    for (const id of ids) this.readReservations.set(id, owner);
    return owner;
  }

  releaseReads(owner) {
    for (const [id, reservedBy] of this.readReservations) {
      if (reservedBy === owner) this.readReservations.delete(id);
    }
  }

  markRead(id, signal, { owner, beforeWrite } = {}) {
    if (typeof id !== "string" || !/^[1-9]\d{0,63}$/.test(id)) {
      throw new InboxError("invalid_thread", "Use a valid notification thread ID.", 400);
    }
    if (this.pendingReads.has(id)) throw new InboxError("busy", "This notification is already being marked as read.", 409);
    if (this.readReservations.has(id) && this.readReservations.get(id) !== owner) {
      throw new InboxError("busy", "This notification belongs to an active repository batch.", 409);
    }
    this.pendingReads.add(id);
    const pending = this.queue.then(async () => {
      const delay = this.writeAvailableAt - this.now();
      if (delay > 0) {
        try {
          await this.sleep(delay, undefined, { signal });
        } catch {
          throw new InboxError("closed", "The canvas was closed.", 410);
        }
      }
      if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
      if (this.now() < this.blockedUntil) throw this.lastError ??
        new InboxError("rate_limited", "GitHub requests are paused until the rate limit resets.", 429);
      beforeWrite?.();
      try {
        await this.request(`/notifications/threads/${id}`, signal, "PATCH");
      } finally {
        this.writeAvailableAt = this.now() + 1000;
      }
      this.revision++;
      for (const page of this.cache.values()) {
        page.items = page.items.filter(item => item.id !== id);
        page.etag = undefined;
        page.modified = undefined;
      }
      for (const listener of this.readListeners) listener(id);
    }).finally(() => this.pendingReads.delete(id));
    this.queue = pending.catch(() => {});
    return pending;
  }

  async request(endpoint, signal, method = "GET", { force = false } = {}) {
    if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    const now = this.now();
    if (now < this.blockedUntil) throw this.lastError ??
      new InboxError("rate_limited", "GitHub requests are paused until the rate limit resets.", 429);
    const cached = method === "GET" ? this.cache.get(endpoint) : undefined;
    if (!force && cached && now < cached.nextRefreshAt) return cached;
    const requestKey = `${method} ${endpoint}`;
    const clearFailure = () => {
      this.failures.delete(requestKey);
      this.lastError = null;
    };
    const args = ["api", "--hostname", "github.com", "--method", method, "--include",
      "-H", "Accept: application/vnd.github+json",
      "-H", "X-GitHub-Api-Version: 2022-11-28"];
    if (cached?.etag) args.push("-H", `If-None-Match: ${cached.etag}`);
    else if (cached?.modified) args.push("-H", `If-Modified-Since: ${cached.modified}`);
    args.push(endpoint);
    let response;
    try {
      response = parseResponse(await this.run(args, { signal }));
      if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
      const { status, headers } = response;
      const fetchedAt = this.now();
      const poll = Math.max(POLL_MS, seconds(headers["x-poll-interval"]));
      const reset = seconds(headers["x-ratelimit-reset"]);
      const retry = seconds(headers["retry-after"]) ||
        Math.max(0, Date.parse(headers["retry-after"]) - fetchedAt) || 0;
      const exhausted = headers["x-ratelimit-remaining"] === "0";
      if (retry) this.blockedUntil = Math.max(this.blockedUntil, fetchedAt + retry);
      if (exhausted) this.blockedUntil = Math.max(this.blockedUntil, reset + 1000, fetchedAt + poll);
      if (status === 429 || (status === 403 && (exhausted || retry ||
          /rate limit|abuse detection|secondary limit/i.test(response.text)))) {
        this.blockedUntil = Math.max(this.blockedUntil, fetchedAt + retry, fetchedAt + poll);
        throw new InboxError("rate_limited", "GitHub rate limit reached. Requests are paused; wait for the retry time.", 429);
      }
      if (status === 401) throw new InboxError("authentication",
        "GitHub sign-in expired. Run gh auth login --hostname github.com. This view retries automatically while visible.", 401);
      if (status === 403 || status === 404) throw new InboxError("permission",
        "GitHub denied notifications access. Check gh auth status; grant notifications scope with gh auth refresh --hostname github.com --scopes notifications. Check organization SSO if applicable. Fine-grained tokens are unsupported.", 403);
      if (!(method === "PATCH" ? [205, 304] : [200, 304]).includes(status)) throw new InboxError("github_http",
        `GitHub returned HTTP ${status}. Check GitHub status and try again.`, 502);
      if (method === "PATCH") {
        clearFailure();
        return;
      }
      if (status === 304 && !cached) throw new InboxError("invalid_response", "GitHub returned 304 without a cached inbox.");
      let items = cached?.items;
      let next = cached?.next;
      if (status === 200) {
        let body;
        try {
          body = JSON.parse(response.text);
        } catch {
          throw new InboxError("invalid_response", "GitHub returned invalid JSON; the previous inbox was kept.");
        }
        items = normalizeThreads(body);
        next = nextPage(headers.link, endpoint);
      }
      const page = {
        items, next, fetchedAt, nextRefreshAt: Math.max(fetchedAt + poll, this.blockedUntil),
        etag: headers.etag ?? (status === 304 ? cached?.etag : undefined),
        modified: headers["last-modified"] ?? (status === 304 ? cached?.modified : undefined),
      };
      this.cache.set(endpoint, page);
      clearFailure();
      return page;
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
      if (error.code !== "closed") {
        const failureCount = (this.failures.get(requestKey) ?? 0) + 1;
        this.failures.set(requestKey, failureCount);
        this.blockedUntil = Math.max(this.blockedUntil,
          this.now() + Math.min(30 * 60_000, POLL_MS * 2 ** Math.min(failureCount - 1, 4)),
          this.now() + seconds(response?.headers["x-poll-interval"]));
        this.lastError = error;
      }
      throw error;
    }
  }

  clear() {
    this.cache.clear();
  }
}
