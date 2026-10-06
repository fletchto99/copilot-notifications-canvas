import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { GitHubClient, firstPage, POLL_MS } from "./github.mjs";
import { groupThreads, InboxError, orderedThreads } from "./model.mjs";
import { acquireLock, ownerPattern, processAlive, removeFile } from "./lock.mjs";
import { notifyDesktop, desktopCapabilities, soundValue, validSound } from "./notifier.mjs";

const CHECK_MS = 5000;
const BURST_THRESHOLD = 5;
const MAX_STATE_BYTES = 262_144;
const watchingMessage = "Watching in the background while a Notifications canvas is open. System notification settings control delivery.";
const storageMessage = "Desktop notification coordination failed. Check permissions and the desktop-state.json, desktop-watchers and .desktop.lock entries in the extension artifacts directory.";
const blankState = () => ({
  version: 1, watchers: [], generation: null, watermark: null, fingerprints: [], nextPollAt: 0, error: null,
});
const timestamp = value => Number.isFinite(value) && value >= 0;
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
    if (!state || state.version !== 1 || !Array.isArray(state.watchers) ||
        state.watchers.some(owner => typeof owner !== "string" || !ownerPattern.test(owner)) ||
        !(state.generation === null || typeof state.generation === "string") ||
        !(state.watermark === null || timestamp(state.watermark)) ||
        !Array.isArray(state.fingerprints) ||
        state.fingerprints.some(key => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) ||
        !timestamp(state.nextPollAt) || !(state.error === null || typeof state.error === "string")) {
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

async function saveState(path, state) {
  const content = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new InboxError("desktop_storage", storageMessage, 500);
  const temporary = `${path}-${randomUUID()}.tmp`;
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

function recordActivity(state, items, now) {
  const unread = orderedThreads(items).filter(item => item.unread);
  const latest = Math.max(state.watermark ?? now, ...unread.map(item => Date.parse(item.updatedAt)));
  const known = new Set(state.fingerprints);
  const arrivals = state.watermark === null ? [] : unread.filter(item => {
    const time = Date.parse(item.updatedAt);
    return time > state.watermark || (time === state.watermark && !known.has(fingerprint(item)));
  });
  const boundary = new Set(latest === state.watermark ? state.fingerprints : []);
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
      : group.items.map(item => ({ title: group.repository, body: item.title })));
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
    this.timer = this.schedule(() => { void this.check(); }, 0);
    this.timer?.unref?.();
  }

  async remove(instanceId) {
    this.panels.delete(instanceId);
    if (this.panels.size) return;
    this.cancel(this.timer);
    this.controller?.abort();
    await this.pending;
    if (!this.panels.size) {
      try {
        await this.unregister();
        this.client.clear();
        this.setStatus("off", "Desktop notifications stopped because this session has no open Notifications canvas.");
      } catch (error) {
        this.setStatus("error", errorMessage(error));
      }
    }
  }

  async close() {
    this.panels.clear();
    await this.remove();
  }

  check() {
    if (this.pending) return this.pending;
    if (!this.panels.size) return Promise.resolve();
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.run(controller.signal).catch(error => {
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

  async register() {
    if (this.registered) return;
    await mkdir(this.watchersPath, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.watchersPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid watcher directory");
    await writeFile(this.markerPath, "", { flag: "wx", mode: 0o600 });
    this.registered = true;
  }

  async unregister() {
    if (!this.registered) return;
    await removeFile(this.markerPath);
    this.registered = false;
    this.owner = `owner-${process.pid}-${randomUUID()}`;
    this.markerPath = join(this.watchersPath, this.owner);
  }

  async activeWatchers() {
    const active = [];
    for (const entry of await readdir(this.watchersPath, { withFileTypes: true })) {
      const match = entry.name.match(ownerPattern);
      if (!entry.isFile() || !match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Invalid watcher marker");
      if (this.alive(Number(match[1]))) active.push(entry.name);
      else await removeFile(join(this.watchersPath, entry.name));
    }
    return active;
  }

  async run(signal) {
    const settings = await this.preferences.document();
    signal.throwIfAborted();
    this.enabled = settings.desktopNotifications === true;
    if (!settings.desktopNotifications || !this.supported) {
      await this.unregister();
      this.setStatus("off", this.supported ? "Desktop notifications are off." :
        this.capabilities.help);
      return;
    }
    if (!validSound(soundValue(settings.desktopSound), this.platform)) {
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
      const watchers = await this.activeWatchers();
      if (!state.watchers.some(owner => watchers.includes(owner)) || state.generation !== generation(settings)) {
        state.watermark = null;
        state.fingerprints = [];
        state.error = null;
      }
      state.watchers = watchers;
      state.generation = generation(settings);
      signal.throwIfAborted();
      if (this.now() < state.nextPollAt) {
        if (JSON.stringify(state) !== previous) await saveState(this.statePath, state);
        this.setStatus(state.error ? "error" : "watching", state.error || watchingMessage);
        return;
      }
      // Reserve the next poll before network I/O so a crashed poller cannot cause a retry storm.
      state.nextPollAt = this.now() + POLL_MS;
      await saveState(this.statePath, state);
      try {
        let next = firstPage();
        const items = [];
        while (next) {
          const page = await this.client.page(next, signal);
          signal.throwIfAborted();
          items.push(...page.items);
          state.nextPollAt = Math.max(state.nextPollAt, page.nextRefreshAt);
          next = state.watermark !== null && !page.items.some(item => Date.parse(item.updatedAt) < state.watermark) ? page.next : null;
        }
        signal.throwIfAborted();
        const arrivals = recordActivity(state, items, this.now());
        state.watchers = await this.activeWatchers();
        state.error = null;
        // Claim activity durably before delivery: a crash may lose an alert, but never replay it.
        await saveState(this.statePath, state);
        for (const message of notificationMessages(arrivals)) {
          const current = await this.preferences.document();
          signal.throwIfAborted();
          if (!current.desktopNotifications || generation(current) !== state.generation) break;
          await this.notify({ ...message,
            sound: soundValue(current.desktopSound), platform: this.platform, signal });
        }
        this.setStatus("watching", watchingMessage);
      } catch (error) {
        if (signal.aborted) throw error;
        state.nextPollAt = Math.max(state.nextPollAt, this.now() + POLL_MS, this.client.blockedUntil);
        state.error = errorMessage(error);
        await saveState(this.statePath, state);
        throw error;
      }
    } finally {
      await release();
    }
  }
}
