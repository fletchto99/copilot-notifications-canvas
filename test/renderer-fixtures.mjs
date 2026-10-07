import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { Inbox } from "../src/inbox.mjs";
import { GitHubClient } from "../src/github.mjs";
import { desktopCapabilities } from "../src/notifier.mjs";
import { orderedThreads } from "../src/model.mjs";
import { http, thread } from "./fixtures.mjs";

export const script = await readFile(process.env.NOTIFICATIONS_TEST_SCRIPT ??
  new URL("../src/app.mjs", import.meta.url), "utf8");
export const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
export const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
export const settle = () => new Promise(resolve => setImmediate(resolve));

// Minimal DOM/event/timer doubles exercise the actual renderer without a browser dependency.
export async function renderer({ hidden = false, token = "a".repeat(64), readFailure = false,
  initialRows, onWrite, onFetch, onState, onFilters, initialOffline = false, release,
  onUpdates, clipboardFailure = false, onSettings, retainDisabledFocus = false, desktopPlatform = "darwin", desktopStatus = {},
  storedSettings = { autoOpen: false, darkMode: null, desktopNotifications: false, desktopSound: "default" },
  appColorMode = "light", systemDark = false } = {}) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  let intersect;
  let themeChanged;
  let themeDisconnected = false;
  let now = Date.now();
  let offline = initialOffline;
  let rows = initialRows ?? [
    thread("1", { subject: { title: "<img src=x onerror=alert(1)>", type: "Issue", url: null } }),
    thread("2", { unread: false }),
  ];
  let releaseMetadata = {
    currentVersion: "0.1.0", latestVersion: "0.1.0", status: "current", checking: false,
    checkedAt: now, nextCheckAt: now + 15 * 60_000, canCheckAt: 0, error: null,
    releaseUrl: "https://github.com/fletchto99/copilot-notifications-canvas/releases/tag/v0.1.0",
    instructionsUrl: "https://github.com/fletchto99/copilot-notifications-canvas#installation-and-updating", prompt: null,
    ...release,
  };
  const copied = [];
  const patches = [];
  const githubCalls = [];
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.events = {};
      this.textContent = "";
      this.value = "";
      this._disabled = false;
      this._hidden = false;
    }
    get disabled() { return this._disabled; }
    set disabled(value) {
      this._disabled = Boolean(value);
      if (value && !retainDisabledFocus && document.activeElement === this) document.activeElement = document.body;
    }
    get hidden() { return this._hidden; }
    set hidden(value) {
      this._hidden = Boolean(value);
      if (value && this.contains(document.activeElement)) document.activeElement = document.body;
    }
    set innerHTML(_) { throw new Error("HTML interpolation is forbidden"); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    append(...children) {
      for (const child of children) child.parentNode = this;
      this.children.push(...children);
    }
    replaceChildren(fragment) {
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      for (const child of this.children) child.parentNode = null;
      this.children = fragment.children;
      for (const child of this.children) child.parentNode = this;
    }
    addEventListener(name, handler) { this.events[name] = handler; }
    select() { this.selected = true; }
    focus() {
      if (this.disabled) return;
      let node = this;
      while (node) {
        if (node.hidden) return;
        if (!node.parentNode && !node.id && !["body", "html"].includes(node.tag)) return;
        node = node.parentNode;
      }
      document.activeElement = this;
    }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) {
      const result = [];
      for (const child of this.children) {
        if (child.tag === selector || (selector === "[data-focus-key]" && child.dataset.focusKey)) result.push(child);
        result.push(...child.querySelectorAll(selector));
      }
      return result;
    }
  }
  const ids = new Map([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)].map(([, tag, id]) => {
    const node = new Node(tag);
    node.id = id;
    return [id, node];
  }));
  const desktopLabel = new Node("span");
  desktopLabel.textContent = "Desktop notifications";
  ids.get("desktop-notifications").append(desktopLabel);
  for (const id of ["batch-stop", "batch-retry", "batch-dismiss"]) ids.get(id).parentNode = ids.get("batch-progress");
  ids.get("batch-progress").contains = node =>
    ["batch-progress", "batch-stop", "batch-retry", "batch-dismiss"].some(id => ids.get(id) === node);
  ids.get("settings").contains = node =>
    node === ids.get("settings") ||
    ["settings-toggle", "settings-panel", "auto-open", "theme", "group-by", "check-updates", "desktop-notifications", "desktop-sound"].some(id => ids.get(id).contains(node));
  const document = {
    hidden,
    body: new Node("body"),
    documentElement: new Node("html"),
    events: {},
    getElementById(id) {
      return ids.get(id) ?? null;
    },
    createElement: tag => new Node(tag),
    createDocumentFragment: () => new Node("fragment"),
    querySelectorAll: selector => [...ids.values()].flatMap(node => node.querySelectorAll(selector)),
    addEventListener(name, handler) { this.events[name] = handler; },
  };
  const window = { events: {}, addEventListener(name, handler) { this.events[name] = handler; } };
  if (appColorMode !== null) document.documentElement.setAttribute("data-color-mode", appColorMode);
  const media = {
    matches: systemDark, events: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    removeEventListener(name) { delete this.events[name]; },
  };
  window.matchMedia = () => media;
  const inbox = new Inbox(new GitHubClient({ now: () => now, sleep: async delay => { now += delay; }, run: async args => {
    githubCalls.push(args);
    if (args.includes("PATCH")) {
      patches.push(args.at(-1));
      if (onWrite) return onWrite(args.at(-1), patches.length);
      return readFailure ? http({}, {}, 403) : "HTTP/2 205 Reset Content\r\n\r\n";
    }
    return onFetch ? onFetch(args) : http(rows);
  } }));
  const context = createContext({
    document, window, location: { hash: `#${token}` }, Intl, AbortController, orderedThreads,
    navigator: { clipboard: { writeText: async text => {
      if (clipboardFailure) throw new Error("Clipboard denied");
      copied.push(text);
    } } },
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    IntersectionObserver: class {
      constructor(callback) { intersect = callback; }
      observe() {}
      disconnect() {}
    },
    MutationObserver: class {
      constructor(callback) { themeChanged = callback; }
      observe() {}
      disconnect() { themeDisconnected = true; }
    },
    fetch: async (path, options) => {
      if (offline) throw new Error("Synthetic connection failure");
      calls.push({ path, options });
      if (path === "/api/settings") {
        const input = options.body ? JSON.parse(options.body) : undefined;
        if (onSettings) await onSettings(input);
        if (input) Object.assign(storedSettings, input);
        const capabilities = desktopCapabilities(desktopPlatform);
        return { ok: true, json: async () => ({ desktopNotifications: false, desktopSound: "default", ...storedSettings,
          desktopStatus: { ...capabilities, state: "watching",
            message: capabilities.supported ? "Watching in the background." : capabilities.help, ...desktopStatus },
        }) };
      }
      if (path === "/api/updates") {
        if (onUpdates) releaseMetadata = await onUpdates();
        return { ok: true, json: async () => releaseMetadata };
      }
      if (path === "/api/refresh") await inbox.refresh(JSON.parse(options.body));
      if (path === "/api/more") await inbox.more();
      if (path === "/api/state") {
        const snapshot = { ...inbox.snapshot(), updates: releaseMetadata };
        if (onState) await onState();
        return { ok: true, json: async () => snapshot };
      }
      if (path === "/api/filters") {
        const input = JSON.parse(options.body);
        if (onFilters) await onFilters(input);
        await inbox.setFilters(input);
      }
      if (path === "/api/read") await inbox.markRead(JSON.parse(options.body));
      if (path.startsWith("/api/batch/")) inbox.batch[path.slice("/api/batch/".length)](JSON.parse(options.body));
      return { ok: true, json: async () => ({ ...inbox.snapshot(), updates: releaseMetadata }) };
    },
  });
  if (!process.env.NOTIFICATIONS_TEST_SCRIPT) assert.match(script, /^import \{ orderedThreads \} from "\.\/model\.mjs";/);
  // Preserve source offsets for the coverage report when removing the injected import.
  runInContext(script.replace(/^import \{ orderedThreads \} from "\.\/model\.mjs";/, match => " ".repeat(match.length)), context, {
    filename: process.env.NOTIFICATIONS_TEST_SCRIPT ?? fileURLToPath(new URL("../src/app.mjs", import.meta.url)),
  });
  await settle();
  return {
    calls, document, window, ids, timers, context, inbox, patches, githubCalls, copied, media,
    get themeDisconnected() { return themeDisconnected; },
    setAppTheme(mode) {
      if (mode === null) delete document.documentElement.attributes["data-color-mode"];
      else document.documentElement.setAttribute("data-color-mode", mode);
      themeChanged();
    },
    setSystemTheme(dark) {
      media.matches = dark;
      media.events.change?.();
    },
    advance(milliseconds = 120_000) { now += milliseconds; return now; },
    async fireTimer(delay = 5000) {
      const [id, timer] = [...timers].find(([, timer]) => timer.delay === delay);
      timers.delete(id);
      await timer.fn();
      await settle();
    },
    setRows(value) { rows = value; },
    setOffline(value) { offline = value; },
    setRelease(value) { releaseMetadata = { ...releaseMetadata, ...value }; },
    intersect: value => intersect([{ isIntersecting: value }]),
  };
}
