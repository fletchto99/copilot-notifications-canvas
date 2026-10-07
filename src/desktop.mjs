import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { GitHubClient, firstPage, POLL_MS } from "./github.mjs";
import { groupThreads, InboxError, notificationTitle, orderedThreads } from "./model.mjs";
import { acquireLock, ownerPattern, processAlive, removeFile } from "./lock.mjs";
import { notifyDesktop, desktopCapabilities, validSound } from "./notifier.mjs";

const CHECK_MS = 5000;
const BURST_THRESHOLD = 5;
const STATE_VERSION = 2;
const MAX_STATE_BYTES = 262_144;
const watchingMessage = "Watching in the background while a Notifications canvas is open. System notification settings control delivery.";
const storageMessage = "Desktop notification coordination failed. Check permissions and the desktop-state.json, desktop-watchers, .desktop.lock and .desktop-watchers.lock entries in the extension artifacts directory.";
const blankState = () => ({
  version: STATE_VERSION, watchers: [], cohort: null, generation: null, watermark: null, fingerprints: [], nextPollAt: 0, error: null,
});
const timestamp = value => Number.isFinite(value) && value >= 0;
const cohortID = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fingerprint = item => createHash("sha256").update(`${item.id}:${item.updatedAt}`).digest("hex");
const generation = settings => settings.desktopGeneration ?? "manual";

function errorMessage(error) {
  return error instanceof InboxError ? error.message : storageMessage;
}

async function readState(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error("Invalid desktop state file");
    const state = JSON.parse(await file.readFile("utf8"));
    if (!state || state.version !== STATE_VERSION || !Array.isArray(state.watchers) ||
        state.watchers.some(owner => typeof owner !== "string" || !ownerPattern.test(owner)) ||
        (state.cohort !== null && !cohortID(state.cohort)) ||
        !(state.generation === null || typeof state.generation === "string") ||
        !(state.watermark === null || timestamp(state.watermark)) ||
        !Array.isArray(state.fingerprints) ||
        state.fingerprints.some(key => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) ||
        !timestamp(state.nextPollAt) || !(state.error === null || typeof state.error === "string") ||
        (state.polling !== undefined && typeof state.polling !== "boolean")) {
      throw new Error("Invalid desktop state");
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return blankState();
    throw new InboxError("desktop_storage", storageMessage, 500);
  } finally {
    await file?.close();
  }
}

async function saveDocument(path, data, temporaryDirectory = dirname(path)) {
  const content = `${JSON.stringify(data)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new InboxError("desktop_storage", storageMessage, 500);
  const temporary = join(temporaryDirectory, `.desktop-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await removeFile(temporary);
  }
}

function initialBoundary(page) {
  const times = page.items.filter(item => item.unread).map(item => Date.parse(item.updatedAt));
  const boundary = times.length ? Math.max(...times) : page.serverTime;
  if (!timestamp(boundary)) {
    throw new InboxError("desktop_baseline",
      "GitHub did not provide a valid snapshot timestamp for the inbox. Desktop alerts will retry before establishing a baseline.", 502);
  }
  return boundary;
}

function recordActivity(state, items, baseline, initial) {
  const unread = orderedThreads(items).filter(item => item.unread);
  const previous = state.watermark;
  const latest = initial ? Math.max(previous ?? baseline, baseline) :
    Math.max(state.watermark, ...unread.map(item => Date.parse(item.updatedAt)));
  const known = new Set(state.fingerprints);
  const arrivals = initial ? [] : unread.filter(item => {
    const time = Date.parse(item.updatedAt);
    return time > state.watermark || (time === state.watermark && !known.has(fingerprint(item)));
  });
  const boundary = new Set(latest === previous ? state.fingerprints : []);
  for (const item of unread) {
    if (Date.parse(item.updatedAt) === latest) boundary.add(fingerprint(item));
  }
  state.watermark = latest;
  state.fingerprints = [...boundary];
  return arrivals;
}

function notificationMessages(arrivals) {
  return groupThreads(arrivals, { query: "" }).flatMap(group =>
    group.items.length >= BURST_THRESHOLD
      ? [{ title: group.repository, body: `${group.items.length} new notifications` }]
      : group.items.map(item => ({ title: group.repository, body: notificationTitle(item) })));
}

export class DesktopNotifications {
  constructor({ preferences, client = new GitHubClient(), notify = notifyDesktop, log = () => {},
    platform = process.platform, now = Date.now, alive = processAlive,
    schedule = setTimeout, cancel = clearTimeout } = {}) {
    this.preferences = preferences;
    this.client = client;
    this.notify = notify;
    this.log = log;
    this.platform = platform;
    this.capabilities = desktopCapabilities(platform);
    this.supported = this.capabilities.supported;
    this.now = now;
    this.alive = alive;
    this.schedule = schedule;
    this.cancel = cancel;
    this.panels = new Set();
    this.owner = `owner-${process.pid}-${randomUUID()}`;
    this.directory = preferences.directory;
    this.watchersPath = join(this.directory, "desktop-watchers");
    this.markerPath = join(this.watchersPath, this.owner);
    this.statePath = join(this.directory, "desktop-state.json");
    this.status = { supported: this.supported, state: "off", message: "Desktop notifications are off." };
  }

  snapshot() {
    return { ...this.status, ...this.capabilities };
  }

  setStatus(state, message) {
    if (state === "error" && this.status.message !== message) this.log(message, { level: "error" });
    this.status = { supported: this.supported, state, message };
  }

  add(instanceId) {
    this.panels.add(instanceId);
    this.wake();
  }

  wake(settings) {
    this.cancel(this.timer);
    if (settings && settings.desktopNotifications !== this.enabled) {
      this.enabled = settings.desktopNotifications;
      this.setStatus(this.enabled ? "starting" : "off",
        this.enabled ? "Starting the shared desktop notification watcher..." : "Desktop notifications are off.");
      if (!this.enabled) this.controller?.abort();
    }
    if (!this.panels.size) return;
    const since = this.client.sequence;
    this.timer = this.schedule(() => { void this.check({ since }); }, 0);
    this.timer?.unref?.();
  }

  async remove(instanceId) {
    this.panels.delete(instanceId);
    if (this.panels.size) return;
    this.cancel(this.timer);
    this.controller?.abort();
    await this.pending;
    await this.foregroundPending;
    if (!this.panels.size) {
      try {
        await this.unregister({ onlyWhenClosed: true });
        if (!this.panels.size) {
          this.client.clear();
          this.setStatus("off", "Desktop notifications stopped because this session has no open Notifications canvas.");
        }
      } catch (error) {
        this.setStatus("error", errorMessage(error));
      }
    }
  }

  async close() {
    this.panels.clear();
    await this.remove();
  }

  sync({ since = this.client.sequence } = {}) {
    this.foregroundRequested = true;
    this.foregroundSince = since;
    if (this.foregroundPending) return this.foregroundPending;
    this.foregroundPending = (async () => {
      do {
        await this.pending;
        this.foregroundRequested = false;
        await this.check({ foreground: true, since: this.foregroundSince });
      } while (this.foregroundRequested && this.panels.size);
    })().finally(() => { this.foregroundPending = undefined; });
    return this.foregroundPending;
  }

  check({ foreground = false, since = this.client.sequence } = {}) {
    if (this.pending) return this.pending;
    if (!this.panels.size) return Promise.resolve();
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.run(controller.signal, foreground, since).catch(error => {
      if (!controller.signal.aborted) this.setStatus("error", errorMessage(error));
    }).finally(() => {
      this.pending = undefined;
      this.cancel(this.timer);
      if (this.panels.size) {
        this.timer = this.schedule(() => { void this.check(); }, CHECK_MS);
        this.timer?.unref?.();
      }
    });
    return this.pending;
  }

  async registrationLock() {
    for (let attempt = 0; attempt < 40; attempt++) {
      const release = await acquireLock(join(this.directory, ".desktop-watchers.lock"), { alive: this.alive });
      if (release) return release;
      await wait(25);
    }
    throw new InboxError("desktop_busy", "Another canvas is updating desktop watcher registration. Retrying shortly.", 503);
  }

  async register() {
    if (this.registered) return;
    await mkdir(this.watchersPath, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.watchersPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid watcher directory");
    const release = await this.registrationLock();
    try {
      if (this.registered) return;
      const cohorts = new Set((await this.activeWatchers()).map(watcher => watcher.cohort).filter(Boolean));
      if (cohorts.size > 1) throw new Error("Inconsistent watcher cohorts");
      this.cohort = [...cohorts][0] ?? randomUUID();
      // Registration must not wait for a poll or native delivery to record continuity.
      await saveDocument(this.markerPath, { cohort: this.cohort }, this.directory);
      this.registered = true;
    } finally {
      await release();
    }
  }

  async unregister({ onlyWhenClosed = false } = {}) {
    if (!this.registered) return;
    const owner = this.owner;
    const release = await this.registrationLock();
    try {
      if (!this.registered || this.owner !== owner || (onlyWhenClosed && this.panels.size)) return;
      while (true) {
        await removeFile(this.markerPath);
        this.registered = false;
        if (!onlyWhenClosed || !this.panels.size) break;
        // A panel can reopen during removal, then close again during restoration.
        await saveDocument(this.markerPath, { cohort: this.cohort }, this.directory);
        this.registered = true;
        if (this.panels.size) return;
      }
      this.cohort = null;
      this.owner = `owner-${process.pid}-${randomUUID()}`;
      this.markerPath = join(this.watchersPath, this.owner);
    } finally {
      await release();
    }
  }

  async activeWatchers() {
    const active = [];
    for (const entry of await readdir(this.watchersPath, { withFileTypes: true })) {
      const match = entry.name.match(ownerPattern);
      if (!entry.isFile() || !match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Invalid watcher marker");
      const path = join(this.watchersPath, entry.name);
      if (!this.alive(Number(match[1]))) {
        await removeFile(path);
        continue;
      }
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024) throw new Error("Invalid watcher marker");
        const text = await file.readFile("utf8");
        // Empty markers belong to older extension processes.
        const cohort = text === "" ? null : JSON.parse(text)?.cohort;
        if (cohort !== null && !cohortID(cohort)) throw new Error("Invalid watcher cohort");
        active.push({ owner: entry.name, cohort });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      } finally {
        await file?.close();
      }
    }
    return active;
  }

  async run(signal, foreground, since) {
    const settings = await this.preferences.document();
    signal.throwIfAborted();
    this.enabled = settings.desktopNotifications === true;
    if (!settings.desktopNotifications || !this.supported) {
      await this.unregister();
      this.setStatus("off", this.supported ? "Desktop notifications are off." :
        this.capabilities.help);
      return;
    }
    if (!validSound(settings.desktopSound ?? "default", this.platform)) {
      throw new InboxError("desktop_sound", "Choose a notification sound supported by this operating system.", 400);
    }
    await this.register();
    signal.throwIfAborted();
    const release = await acquireLock(join(this.directory, ".desktop.lock"), { alive: this.alive });
    if (!release) {
      const state = await readState(this.statePath);
      this.setStatus(state.error ? "error" : "shared", state.error || "Another Notifications canvas is checking for desktop alerts.");
      return;
    }
    try {
      const state = await readState(this.statePath);
      const previous = JSON.stringify(state);
      const initial = state.watermark === null ||
        state.cohort !== this.cohort || state.generation !== generation(settings);
      state.watchers = (await this.activeWatchers()).map(watcher => watcher.owner);
      signal.throwIfAborted();
      // Foreground reads already refreshed the shared cache. Failed or interrupted
      // polls still retain their durable retry reservation, including older checkpoints.
      if (this.now() < state.nextPollAt && (!foreground || state.polling !== false || state.error)) {
        if (JSON.stringify(state) !== previous) await saveDocument(this.statePath, state);
        this.setStatus(state.error ? "error" : "watching", state.error || watchingMessage);
        return;
      }
      // Reserve the next poll before network I/O so a crashed poller cannot cause a retry storm.
      state.nextPollAt = Math.max(state.nextPollAt, this.now() + POLL_MS);
      state.polling = true;
      await saveDocument(this.statePath, state);
      try {
        let next = firstPage();
        let minSequence = initial ? since + 1 : 0;
        let boundary = initial ? null : state.watermark;
        const items = [];
        while (next) {
          const page = await this.client.page(next, signal, { minSequence, allowCachedDuringBackoff: true });
          signal.throwIfAborted();
          minSequence = page.sequence;
          items.push(...page.items);
          state.nextPollAt = Math.max(state.nextPollAt, page.nextRefreshAt);
          if (boundary === null) boundary = initialBoundary(page);
          next = page.items.some(item => item.unread && Date.parse(item.updatedAt) < boundary) ? null : page.next;
        }
        signal.throwIfAborted();
        const arrivals = recordActivity(state, items, boundary, initial);
        state.cohort = this.cohort;
        state.generation = generation(settings);
        state.watchers = (await this.activeWatchers()).map(watcher => watcher.owner);
        state.error = null;
        state.polling = false;
        state.nextPollAt = Math.max(state.nextPollAt, this.now() + POLL_MS);
        // Claim activity durably before delivery: a crash may lose an alert, but never replay it.
        await saveDocument(this.statePath, state);
        for (const message of notificationMessages(arrivals)) {
          const current = await this.preferences.document();
          signal.throwIfAborted();
          if (!current.desktopNotifications || generation(current) !== state.generation) break;
          await this.notify({ ...message,
            sound: current.desktopSound ?? "default", platform: this.platform, signal });
        }
        this.setStatus("watching", watchingMessage);
      } catch (error) {
        if (signal.aborted) throw error;
        state.nextPollAt = Math.max(state.nextPollAt, this.now() + POLL_MS, this.client.blockedUntil);
        state.error = errorMessage(error);
        await saveDocument(this.statePath, state);
        throw error;
      }
    } finally {
      await release();
    }
  }
}
