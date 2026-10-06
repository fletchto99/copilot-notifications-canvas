import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { Inbox } from "../.github/extensions/github-notifications/inbox.mjs";
import { GitHubClient } from "../.github/extensions/github-notifications/github.mjs";
import { desktopCapabilities } from "../.github/extensions/github-notifications/notifier.mjs";
import { http, thread } from "./fixtures.mjs";

const script = await readFile(new URL("../.github/extensions/github-notifications/app.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("../.github/extensions/github-notifications/index.html", import.meta.url), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

// Minimal DOM/event/timer doubles exercise the actual renderer without a browser dependency.
async function renderer({ hidden = false, token = "a".repeat(64), readFailure = false,
  initialRows, onWrite, onFetch, onState, onFilters, initialOffline = false, release,
  onUpdates, clipboardFailure = false, onSettings, desktopPlatform = "darwin",
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
      if (value && document.activeElement === this) document.activeElement = document.body;
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
  for (const id of ["batch-stop", "batch-retry", "batch-dismiss"]) ids.get(id).parentNode = ids.get("batch-progress");
  ids.get("batch-progress").contains = node =>
    ["batch-progress", "batch-stop", "batch-retry", "batch-dismiss"].some(id => ids.get(id) === node);
  ids.get("settings").contains = node =>
    ["settings", "settings-toggle", "settings-panel", "auto-open", "dark-mode", "check-updates", "desktop-notifications", "desktop-sound"].some(id => ids.get(id) === node);
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
    document, window, location: { hash: `#${token}` }, Intl, AbortController,
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
        return { ok: true, json: async () => ({ desktopNotifications: false, desktopSound: "default", ...storedSettings,
          desktopStatus: { ...desktopCapabilities(desktopPlatform), state: "watching", message: "Desktop notification status." },
        }) };
      }
      if (path === "/api/updates") {
        if (onUpdates) releaseMetadata = await onUpdates();
        return { ok: true, json: async () => releaseMetadata };
      }
      if (path === "/api/refresh") await inbox.refresh();
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
  runInContext(script, context);
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

test("update banner sits below the subtitle and above the inbox controls with its prompt collapsed", () => {
  const positions = ['class="subtitle"', 'id="update-banner"', 'class="toolbar"', 'id="count"', 'id="groups"']
    .map(marker => html.indexOf(marker));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
  assert.match(html, /<details id="update-prompt-details">/);
});

test("Settings shows the running version below Check for updates without a duplicate footer version", async () => {
  assert.match(html, /<button id="check-updates"[^>]*>Check for updates<\/button>\s*<p id="installed-version"/);
  assert.doesNotMatch(html, /id="canvas-version"/);
  for (const release of [
    {},
    { status: "available", latestVersion: "0.2.0", prompt: "Synthetic update prompt" },
    { status: "unchecked", checking: true, checkedAt: null },
    { status: "unchecked", error: "Release check failed", checkedAt: null },
  ]) {
    const ui = await renderer({ release });
    assert.equal(ui.ids.get("installed-version").textContent, "GitHub Notification Canvas 0.1.0");
  }
});

test("update banner shows release links and copies a prompt without installing or changing settings", async () => {
  const ui = await renderer({ release: {
    status: "available", latestVersion: "0.2.0", prompt: "Synthetic safe update prompt",
    releaseUrl: "https://github.com/fletchto99/copilot-notifications-canvas/releases/tag/v0.2.0",
  } });
  assert.equal(ui.ids.get("update-banner").hidden, false);
  assert.match(ui.ids.get("update-title").textContent, /v0\.2\.0.*v0\.1\.0/);
  assert.equal(ui.ids.get("installed-version").textContent, "GitHub Notification Canvas 0.1.0");
  assert.match(ui.ids.get("release-notes").href, /\/releases\/tag\/v0\.2\.0$/);
  assert.match(ui.ids.get("update-instructions").href, /#installation-and-updating$/);
  assert.equal(ui.ids.get("update-prompt").value, "Synthetic safe update prompt");
  const count = ui.calls.length;
  await ui.ids.get("copy-update").events.click();
  assert.deepEqual(ui.copied, ["Synthetic safe update prompt"]);
  assert.equal(ui.calls.length, count);
  assert.match(ui.ids.get("copy-status").textContent, /Copied.*Paste/);
  assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
});

test("clipboard denial exposes a selectable prompt and does not claim it was copied", async () => {
  const ui = await renderer({ clipboardFailure: true, release: {
    status: "available", latestVersion: "0.2.0", prompt: "Manual copy prompt",
  } });
  await ui.ids.get("copy-update").events.click();
  assert.equal(ui.ids.get("update-prompt-details").open, true);
  assert.equal(ui.ids.get("update-prompt").selected, true);
  assert.equal(ui.document.activeElement, ui.ids.get("update-prompt"));
  assert.match(ui.ids.get("copy-status").textContent, /Clipboard unavailable/);
  assert.deepEqual(ui.copied, []);
});

test("current, ahead, absent and failed release checks keep the banner out of the inbox", async () => {
  for (const [status, message] of [
    ["current", /^Up to date\.$/], ["ahead", /Newer than/], ["no_release", /No stable/],
  ]) {
    const ui = await renderer({ release: { status } });
    assert.equal(ui.ids.get("update-banner").hidden, true);
    assert.match(ui.ids.get("update-status").textContent, message);
  }
  const ui = await renderer({ release: { status: "unchecked", error: "Network unavailable", checkedAt: null } });
  assert.equal(ui.ids.get("update-banner").hidden, true);
  assert.equal(ui.ids.get("update-status").textContent, "Network unavailable");
  assert.equal(ui.ids.get("update-status").hidden, false);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
});

test("manual release checks stay available while checking and immediately after a result", async () => {
  const ui = await renderer({ onUpdates: async () => ({
    currentVersion: "0.1.0", latestVersion: null, checking: true, status: "unchecked",
    canCheckAt: 0, checkedAt: null,
  }) });
  assert.doesNotMatch(html, /id="check-updates"[^>]*\bdisabled\b/);
  assert.equal(ui.ids.get("check-updates").disabled, false);
  await ui.ids.get("check-updates").events.click();
  assert.equal(ui.calls.at(-1).path, "/api/updates");
  assert.equal(ui.calls.at(-1).options.body, "{}");
  assert.equal(ui.ids.get("check-updates").disabled, false);
  assert.equal(ui.ids.get("check-updates").attributes["aria-busy"], "true");
  assert.equal(ui.ids.get("update-status").textContent, "Checking...");
  assert.equal(ui.ids.get("search").disabled, false);
  await ui.ids.get("check-updates").events.click();
  assert.equal(ui.calls.filter(call => call.path === "/api/updates").length, 2);
  ui.setRelease({ checking: false, status: "current", latestVersion: "0.1.0", checkedAt: ui.advance(0) });
  await ui.fireTimer();
  assert.equal(ui.ids.get("update-status").textContent, "Up to date.");
  assert.equal(ui.ids.get("check-updates").attributes["aria-busy"], "false");
  assert.equal(ui.ids.get("check-updates").disabled, false);
  await ui.ids.get("check-updates").events.click();
  assert.equal(ui.calls.filter(call => call.path === "/api/updates").length, 3);
});

test("GitHub retry delays are explained without disabling the manual check button", async () => {
  const ui = await renderer({ release: {
    error: "GitHub declined the release check.", canCheckAt: Date.now() + 7_200_000,
  } });
  assert.match(ui.ids.get("update-status").textContent, /GitHub declined.*Retry after/);
  assert.equal(ui.ids.get("check-updates").disabled, false);
  await ui.ids.get("check-updates").events.click();
  assert.equal(ui.calls.at(-1).path, "/api/updates");
  assert.match(ui.ids.get("update-status").textContent, /Retry after/);
  assert.equal(ui.ids.get("check-updates").disabled, false);
});

test("release check request failures are visible and hidden panels never trigger manual checks", async () => {
  for (const initialOffline of [false, true]) {
    const ui = await renderer({ initialOffline });
    ui.setOffline(true);
    await ui.ids.get("check-updates").events.click();
    assert.match(ui.ids.get("update-status").textContent, /Synthetic connection failure/);
    assert.equal(ui.ids.get("update-status").hidden, false);
    ui.setOffline(false);
    await ui.ids.get("check-updates").events.click();
    assert.doesNotMatch(ui.ids.get("update-status").textContent, /Synthetic connection failure/);
    ui.intersect(false);
    const count = ui.calls.length;
    await ui.ids.get("check-updates").events.click();
    assert.equal(ui.calls.length, count);
  }
});

test("renderer fetches with a capability, renders untrusted titles as text and exposes accessible controls", async () => {
  const ui = await renderer();
  const refresh = ui.calls.find(call => call.path === "/api/refresh");
  assert.ok(refresh);
  assert.equal(refresh.options.headers.Authorization, `Bearer ${"a".repeat(64)}`);
  assert.equal(refresh.options.credentials, "omit");
  const links = ui.document.querySelectorAll("a");
  assert.equal(links[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(links[0].href, "https://github.com/notifications");
  assert.equal(links[0].rel, "noopener noreferrer");
  assert.equal(ui.ids.has("unread"), false);
  assert.equal(ui.ids.has("all"), false);
  assert.equal(ui.ids.has("refresh"), false);
  assert.equal(ui.ids.get("empty").hidden, true);
  assert.equal(ui.document.querySelectorAll("time")[0].attributes["aria-label"].length > 0, true);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
});

test("canvas is titled Unread Notifications without mode tabs or the old All notice", () => {
  assert.match(html, /<title>Unread Notifications<\/title>/);
  assert.match(html, /<h1>Unread Notifications<\/h1>/);
  assert.doesNotMatch(html, /id="(?:all|unread|api-limit)"/);
});

test("manual Refresh controls are absent while the automatic endpoint and SDK action remain", async () => {
  assert.doesNotMatch(html, /id="refresh"|>Refresh<\/button>|class="heading"/);
  assert.doesNotMatch(script, /\$\("refresh"\)/);
  const extension = await readFile(new URL("../.github/extensions/github-notifications/extension.mjs", import.meta.url), "utf8");
  assert.match(extension, /name: "refresh"/);
  const ui = await renderer();
  assert.ok(ui.calls.some(call => call.path === "/api/refresh"));
  assert.equal(ui.githubCalls.length, 1);
  assert.match(ui.ids.get("updated").textContent, /Checked .*Next refresh/);
});

test("automatic polling honors the two-minute minimum without a manual button", async () => {
  const ui = await renderer();
  ui.advance(119_999);
  await ui.fireTimer();
  assert.equal(ui.calls.at(-1).path, "/api/state");
  assert.equal(ui.githubCalls.length, 1);
  ui.advance(1);
  await ui.fireTimer();
  assert.equal(ui.calls.at(-1).path, "/api/refresh");
  assert.equal(ui.githubCalls.length, 2);
});

test("automatic polling honors a longer GitHub interval and resumes only when visible", async () => {
  const ui = await renderer({ onFetch: () => http([thread()], { "x-poll-interval": "300" }) });
  ui.advance(120_000);
  await ui.fireTimer();
  assert.equal(ui.githubCalls.length, 1);
  ui.advance(179_999);
  await ui.fireTimer();
  assert.equal(ui.githubCalls.length, 1);
  ui.advance(1);
  await ui.fireTimer();
  assert.equal(ui.githubCalls.length, 2);
  ui.intersect(false);
  ui.advance(300_000);
  assert.equal(ui.timers.size, 0);
  await runInContext("tick()", ui.context);
  assert.equal(ui.githubCalls.length, 2);
  ui.intersect(true);
  await settle();
  assert.equal(ui.githubCalls.length, 3);
});

test("authentication errors remain visible and automatically retry after backoff", async () => {
  let fetches = 0;
  const ui = await renderer({ onFetch: () => ++fetches === 2 ? http({}, {}, 401) : http([thread()]) });
  ui.advance();
  await ui.fireTimer();
  assert.equal(ui.ids.get("notice").hidden, false);
  assert.match(ui.ids.get("notice").textContent, /gh auth login/);
  assert.match(ui.ids.get("empty-description").textContent, /retries automatically/);
  ui.advance(119_999);
  await ui.fireTimer();
  assert.equal(fetches, 2);
  ui.advance(1);
  await ui.fireTimer();
  assert.equal(fetches, 3);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.inbox.summary().status, "ready");
});

test("an offline initial open recovers automatically without a Refresh control", async () => {
  const ui = await renderer({ initialOffline: true });
  assert.equal(ui.ids.get("notice").hidden, false);
  assert.equal(ui.ids.get("empty-title").textContent, "Your inbox is unavailable");
  assert.match(ui.ids.get("empty-description").textContent, /retries automatically.*Reopen/);
  assert.equal(ui.githubCalls.length, 0);
  ui.setOffline(false);
  await ui.fireTimer();
  assert.equal(ui.githubCalls.length, 1);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
});

test("search typed during automatic loading is applied after the fetch finishes", async () => {
  let requests = 0;
  let release;
  const ui = await renderer({ onFetch: () => ++requests === 1 ? http([thread()]) :
    new Promise(resolve => { release = () => resolve(http([thread("1"), thread("3")])); }) });
  ui.advance();
  const polling = ui.fireTimer();
  await settle();
  const search = ui.ids.get("search");
  search.value = "notification 3";
  search.events.input();
  await ui.fireTimer(250);
  release();
  await polling;
  assert.equal(ui.calls.at(-1).path, "/api/filters");
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal(ui.document.querySelectorAll("a")[0].textContent, "Synthetic notification 3");
});

test("renderer preserves focus and collapsed groups across unchanged data and updates", async () => {
  const ui = await renderer();
  const firstLink = ui.document.querySelectorAll("a")[0];
  firstLink.focus();
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement, firstLink);
  const group = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.disclosure);
  group.focus();
  group.events.click();
  assert.equal(group.attributes["aria-expanded"], "false");
  assert.equal(ui.ids.get("collapse").textContent, "Expand all");
  await runInContext("state.groups[0].items[0].title = 'Updated synthetic title'; render()", ui.context);
  assert.equal(ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.disclosure).attributes["aria-expanded"], "false");
  assert.equal(ui.document.activeElement.dataset.focusKey, "repo:example/widgets");
});

test("search and clearing search keep working without mode controls", async () => {
  const ui = await renderer();
  const search = ui.ids.get("search");
  search.value = "no match";
  search.events.input();
  [...ui.timers.values()].find(timer => timer.delay === 250).fn();
  await settle();
  assert.equal(ui.calls.at(-1).path, "/api/filters");
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.ids.get("empty-title").textContent, "No matches in loaded notifications");
  await runInContext('update("filters", { query: "" })', ui.context);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
});

test("hidden/non-intersecting/closed documents do not schedule unnecessary work", async () => {
  const ui = await renderer({ hidden: true });
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.timers.size, 0);
  ui.document.hidden = false;
  ui.document.events.visibilitychange();
  await settle();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.timers.size, 1);
  ui.intersect(false);
  await settle();
  assert.equal(ui.timers.size, 0);
  await runInContext("tick()", ui.context);
  assert.equal(ui.calls.length, 2);
  ui.intersect(true);
  await settle();
  assert.equal(ui.calls.length, 4);
  assert.equal(ui.calls[2].path, "/api/state");
  ui.window.events.pagehide();
  assert.equal(ui.timers.size, 0);
  await runInContext("tick()", ui.context);
  assert.equal(ui.calls.length, 4);
});

test("a missing capability remains inert and explains how to open the canvas", async () => {
  const ui = await renderer({ token: "" });
  ui.intersect(true);
  ui.document.events.visibilitychange();
  await settle();
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.timers.size, 0);
  assert.match(ui.ids.get("notice").textContent, /Open this canvas from Copilot/);
  assert.equal(ui.ids.get("check-updates").disabled, true);
});

test("the per-panel Web Audio option is replaced by the native notification sound picker", () => {
  assert.doesNotMatch(html, /id="sound"|Play sound|per-panel chime/);
  assert.match(html, /<label for="desktop-sound"/);
  assert.match(html, /<select id="desktop-sound"/);
  assert.doesNotMatch(script, /AudioContext|NotificationSound|sound\.mjs/);
});

test("Settings uses an icon-only toggle with an accessible name and tooltip", () => {
  const summary = html.match(/<summary\b([^>]*\bid="settings-toggle"[^>]*)>([\s\S]*?)<\/summary>/);
  assert.ok(summary);
  const [, attributes, content] = summary;
  assert.match(attributes, /aria-label="Settings"/);
  assert.match(attributes, /title="Settings"/);
  assert.match(attributes, /aria-controls="settings-panel"/);
  assert.match(attributes, /aria-expanded="false"/);
  assert.match(content, /<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.equal(content.replace(/<[^>]*>/g, "").trim(), "");
});

test("Settings puts an Auto-open slider above sound, saves startup preference and closes accessibly", async () => {
  assert.match(html, /<button\b[^>]*id="auto-open"[^>]*class="switch-toggle"[^>]*role="switch"/);
  assert.match(html, /<span>Auto-open<\/span>\s*<span class="switch-track" aria-hidden="true"><span class="switch-thumb"><\/span><\/span>/);
  assert.ok(html.indexOf('id="auto-open"') < html.indexOf('id="desktop-sound"'));
  assert.doesNotMatch(html, /Open on new sessions:/);
  assert.doesNotMatch(script, /\$\("auto-open"\)\.textContent\s*=/);
  const ui = await renderer();
  const settings = ui.ids.get("settings");
  settings.open = true;
  settings.events.toggle();
  await settle();
  assert.equal(ui.ids.get("settings-toggle").attributes["aria-expanded"], "true");
  assert.equal(ui.ids.get("auto-open").disabled, false);
  assert.equal(ui.ids.get("auto-open").attributes["aria-checked"], "false");
  ui.ids.get("auto-open").events.click();
  await settle();
  assert.equal(ui.ids.get("auto-open").attributes["aria-checked"], "true");
  assert.equal(ui.ids.get("settings-status").textContent, "");
  ui.document.events.click({ target: ui.ids.get("desktop-sound") });
  assert.equal(settings.open, true);
  ui.document.events.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(settings.open, false);
  assert.equal(ui.document.activeElement, ui.ids.get("settings-toggle"));
  settings.open = true;
  settings.events.toggle();
  await settle();
  assert.equal(ui.ids.get("auto-open").attributes["aria-checked"], "true");
  ui.document.events.click({ target: ui.ids.get("search") });
  assert.equal(settings.open, false);
});

test("desktop controls persist independently, preserve focus and are disabled on unsupported hosts", async () => {
  const ui = await renderer();
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  const desktop = ui.ids.get("desktop-notifications");
  const sound = ui.ids.get("desktop-sound");
  assert.equal(desktop.disabled, false);
  assert.equal(desktop.attributes["aria-checked"], "false");
  assert.equal(sound.disabled, true);
  desktop.focus();
  desktop.events.click();
  await settle();
  assert.equal(desktop.attributes["aria-checked"], "true");
  assert.equal(ui.document.activeElement, desktop);
  assert.equal(sound.disabled, false);
  sound.value = "Ping";
  sound.events.change();
  await settle();
  assert.equal(sound.value, "Ping");
  assert.equal(sound.children.some(option => option.value === "Submarine"), true);
  assert.equal(ui.ids.get("settings-status").textContent, "");
  desktop.events.click();
  await settle();
  assert.equal(sound.disabled, true);
  assert.equal(sound.value, "Ping");
  const unsupported = await renderer({ desktopPlatform: "freebsd" });
  unsupported.ids.get("settings").open = true;
  unsupported.ids.get("settings").events.toggle();
  await settle();
  assert.equal(unsupported.ids.get("desktop-notifications").disabled, true);
  assert.equal(unsupported.ids.get("desktop-sound").disabled, true);
  assert.match(unsupported.ids.get("desktop-sound-help").textContent, /macOS, Windows and Linux/);
  assert.equal(unsupported.ids.get("auto-open").disabled, false);
});

test("Windows and Linux sound pickers use their own sound catalogs", async () => {
  for (const [platform, expected] of [["win32", "Mail"], ["linux", "message-new-email"]]) {
    const ui = await renderer({ desktopPlatform: platform });
    ui.ids.get("settings").open = true;
    ui.ids.get("settings").events.toggle();
    await settle();
    assert.equal(ui.ids.get("desktop-notifications").disabled, false);
    const values = ui.ids.get("desktop-sound").children.map(option => option.value);
    assert.ok(values.includes(expected));
    assert.ok(values.includes("none"));
    assert.equal(values.includes("Glass"), false);
  }
});

test("a settings edit during a background status read is queued rather than dropped", async () => {
  let reads = 0;
  let finish;
  const ui = await renderer({ onSettings: input => {
    if (!input && ++reads === 3) return new Promise(resolve => { finish = resolve; });
  } });
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  assert.equal(ui.ids.get("settings-status").hidden, true);
  await ui.fireTimer();
  const control = ui.ids.get("desktop-notifications");
  assert.equal(control.disabled, false);
  assert.equal(ui.ids.get("settings-status").hidden, true);
  control.focus();
  control.events.click();
  assert.equal(control.disabled, true);
  finish();
  await settle();
  assert.equal(control.attributes["aria-checked"], "true");
  assert.equal(ui.document.activeElement, control);
  assert.equal(ui.ids.get("settings-status").hidden, true);
});

test("Settings omits explanatory copy and hides empty status messages", async () => {
  assert.doesNotMatch(html, /dark-mode-help|startup-help|Optional chime|Saved for your user/);
  const ui = await renderer();
  assert.equal(ui.ids.get("settings-status").hidden, true);
  assert.equal(ui.ids.get("update-status").textContent, "Up to date.");
  assert.doesNotMatch(ui.ids.get("update-status").textContent, /Last checked|Check again after/);
});

test("settings failures are visible and do not claim a saved toggle", async () => {
  const ui = await renderer({ initialOffline: true });
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  assert.equal(ui.ids.get("auto-open").disabled, true);
  assert.equal(ui.ids.get("dark-mode").disabled, true);
  assert.equal(ui.ids.get("settings-error").hidden, false);
  assert.equal(ui.ids.get("settings-status").hidden, false);
  assert.match(ui.ids.get("settings-status").textContent, /retry/);
  ui.setOffline(false);
  ui.ids.get("settings").events.toggle();
  await settle();
  assert.equal(ui.ids.get("auto-open").disabled, false);
  assert.equal(ui.ids.get("dark-mode").disabled, false);
  assert.equal(ui.ids.get("settings-error").hidden, true);
  assert.equal(ui.ids.get("settings-status").hidden, true);
});

test("dark mode uses an accessible slider-style switch and follows the app until explicitly saved", async () => {
  assert.match(html, /<button\b[^>]*id="dark-mode"[^>]*role="switch"/);
  assert.match(html, /<span>Dark mode<\/span>\s*<span class="switch-track" aria-hidden="true"><span class="switch-thumb"><\/span><\/span>/);
  const ui = await renderer({ appColorMode: "dark" });
  assert.equal(ui.ids.get("dark-mode").disabled, false);
  assert.equal(ui.ids.get("dark-mode").attributes["aria-checked"], "true");
  assert.equal(ui.document.documentElement.dataset.notificationTheme, undefined);
  ui.setAppTheme("light");
  assert.equal(ui.ids.get("dark-mode").attributes["aria-checked"], "false");
  ui.setAppTheme(null);
  ui.setSystemTheme(true);
  assert.equal(ui.ids.get("dark-mode").attributes["aria-checked"], "true");
  ui.document.body.setAttribute("data-color-mode", "light");
  ui.setSystemTheme(true);
  assert.equal(ui.ids.get("dark-mode").attributes["aria-checked"], "false");
});

test("dark and light choices persist across panels, preserve auto-open and ignore host theme changes", async () => {
  const storedSettings = { autoOpen: true, darkMode: null };
  const ui = await renderer({ storedSettings });
  const toggle = ui.ids.get("dark-mode");
  toggle.focus();
  toggle.events.click();
  assert.equal(toggle.disabled, true);
  await settle();
  assert.equal(toggle.attributes["aria-checked"], "true");
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
  assert.deepEqual(storedSettings, { autoOpen: true, darkMode: true });
  assert.equal(ui.document.activeElement, toggle);
  assert.equal(ui.ids.get("settings-status").textContent, "");
  ui.document.events.click({ target: toggle });
  ui.setAppTheme("light");
  assert.equal(toggle.attributes["aria-checked"], "true");
  const reopened = await renderer({ storedSettings });
  assert.equal(reopened.document.documentElement.dataset.notificationTheme, "dark");
  reopened.ids.get("dark-mode").events.click();
  await settle();
  assert.deepEqual(storedSettings, { autoOpen: true, darkMode: false });
  assert.equal(reopened.document.documentElement.dataset.notificationTheme, "light");
  reopened.setAppTheme("dark");
  reopened.setSystemTheme(true);
  assert.equal(reopened.ids.get("dark-mode").attributes["aria-checked"], "false");
  assert.equal(reopened.document.documentElement.dataset.notificationTheme, "light");
  const lightPanel = await renderer({ storedSettings, appColorMode: "dark" });
  assert.equal(lightPanel.document.documentElement.dataset.notificationTheme, "light");
  assert.equal(ui.patches.length, 0);
});

test("failed dark-mode saves retain the prior theme and focus with an explicit retryable error", async () => {
  const storedSettings = { autoOpen: false, darkMode: true };
  let fail = true;
  const ui = await renderer({ storedSettings, onSettings: input => {
    if (input && fail) throw new Error("Could not save notification settings.");
  } });
  const toggle = ui.ids.get("dark-mode");
  toggle.focus();
  toggle.events.click();
  await settle();
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.attributes["aria-checked"], "true");
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
  assert.equal(storedSettings.darkMode, true);
  assert.equal(ui.document.activeElement, toggle);
  assert.match(ui.ids.get("settings-status").textContent, /Could not save.*retry/);
  assert.doesNotMatch(ui.ids.get("settings-status").textContent, /Saved\./);
  assert.equal(ui.ids.get("settings-error").hidden, false);
  fail = false;
  toggle.events.click();
  await settle();
  assert.equal(storedSettings.darkMode, false);
  assert.equal(ui.ids.get("settings-error").hidden, true);
});

test("a pending theme save blocks duplicate changes without stealing focus", async () => {
  let release;
  const storedSettings = { autoOpen: false, darkMode: false };
  const ui = await renderer({ storedSettings, onSettings: input =>
    input ? new Promise(resolve => { release = resolve; }) : undefined });
  const toggle = ui.ids.get("dark-mode");
  toggle.focus();
  toggle.events.click();
  toggle.events.click();
  assert.equal(ui.calls.filter(call => call.path === "/api/settings" && call.options.body).length, 1);
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "light");
  ui.ids.get("search").focus();
  release();
  await settle();
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
});

test("settings refresh on visibility and theme observers are cleaned up on close", async () => {
  const storedSettings = { autoOpen: false, darkMode: false };
  const ui = await renderer({ storedSettings });
  ui.intersect(false);
  storedSettings.darkMode = true;
  ui.intersect(true);
  await settle();
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
  assert.equal(ui.ids.get("dark-mode").attributes["aria-checked"], "true");
  ui.window.events.pagehide();
  assert.equal(ui.themeDisconnected, true);
  assert.equal(ui.media.events.change, undefined);
});

test("mark-read requires a click and removes only on confirmation", async () => {
  const ui = await renderer();
  assert.equal(ui.calls.some(call => call.path === "/api/read"), false);
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  assert.match(button.attributes["aria-label"], /Mark as read/);
  button.focus();
  const marking = button.events.click();
  assert.equal(button.disabled, true);
  await button.events.click();
  await marking;
  assert.equal(ui.calls.filter(call => call.path === "/api/read").length, 1);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
  ui.window.events.pagehide();
});

test("mark-read failure retains the row with a usable retry control", async () => {
  const ui = await renderer({ readFailure: true });
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  await button.events.click();
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal(button.disabled, false);
  assert.match(ui.ids.get("notice").textContent, /Could not mark/);
});

test("repository action starts from one click with no dialog and preserves independent disclosure", async () => {
  let release;
  const ui = await renderer({
    onWrite: () => new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); }),
  });
  const buttons = ui.ids.get("groups").querySelectorAll("button");
  const disclosure = buttons.find(node => node.dataset.disclosure);
  const groupRead = buttons.find(node => node.dataset.focusKey === "bulk:example/widgets");
  assert.match(groupRead.textContent, /Mark 1 as read/);
  assert.equal(disclosure.contains(groupRead), false);
  assert.equal(groupRead.contains(disclosure), false);
  disclosure.events.click();
  groupRead.focus();
  await groupRead.events.click();
  await settle();
  assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
  assert.deepEqual(ui.calls.filter(call => call.path.startsWith("/api/batch/")).map(call => call.path), ["/api/batch/start"]);
  assert.equal(ui.document.activeElement, ui.ids.get("batch-stop"));
  assert.equal(disclosure.attributes["aria-expanded"], "false");
  assert.match(groupRead.textContent, /Marking 0\/1/);
  assert.equal(groupRead.attributes["aria-busy"], "true");
  assert.doesNotMatch(html, /<dialog|batch-confirm|batch-start|batch-cancel/);
  assert.doesNotMatch(script, /showModal|batch\/prepare|Repository action finished/);
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.ids.get("batch-title").textContent, "");
  assert.equal(ui.ids.get("batch-counts").textContent, "");
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
});

test("one-click repository read honors search, blocks duplicate clicks and quietly clears successful rows", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2")],
    onWrite: () => new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); }),
  });
  await runInContext('update("filters", { query: "notification 1" })', ui.context);
  const groupRead = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.focusKey.startsWith("bulk:"));
  assert.equal(groupRead.textContent, "Mark 1 as read");
  groupRead.focus();
  const first = groupRead.events.click();
  await groupRead.events.click();
  await first;
  assert.equal(ui.ids.get("search").disabled, true);
  assert.equal(ui.inbox.batch.snapshot().total, 1);
  assert.equal(ui.inbox.batch.snapshot().searchActive, true);
  assert.equal(ui.document.activeElement, ui.ids.get("batch-stop"));
  await settle();
  await runInContext("update()", ui.context);
  assert.match(groupRead.textContent, /Marking 0\/1/);
  assert.equal(ui.ids.has("refresh"), false);
  assert.equal(ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1").disabled, true);
  release();
  await ui.inbox.batch.done;
  await runInContext("tick()", ui.context);
  assert.equal(ui.inbox.batch.snapshot(), null);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("batch-counts").textContent, "");
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
  assert.equal(ui.inbox.summary().loaded, 1);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
  ui.window.events.pagehide();
});

test("partial batch progress shows retryable remaining counts without repeating successes or expanding selection", async () => {
  let failures = true;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2"), thread("3")],
    onWrite: (_path, count) => count === 2 && failures ? http({}, {}, 500) : "HTTP/2 205 Reset Content\r\n\r\n",
  });
  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.focusKey.startsWith("bulk:")).events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.match(ui.ids.get("batch-counts").textContent, /1 succeeded \/ 1 failed \/ 0 skipped \/ 1 not attempted/);
  assert.equal(ui.ids.get("batch-retry").hidden, false);
  assert.equal(ui.ids.get("batch-retry").textContent, "Retry remaining (2)");
  assert.equal(ui.ids.get("batch-retry").disabled, true);
  assert.match(ui.ids.get("batch-error").textContent, /HTTP 500/);
  failures = false;
  ui.advance();
  ui.inbox.client.blockedUntil = 0;
  await runInContext("update()", ui.context);
  ui.ids.get("batch-retry").focus();
  await ui.ids.get("batch-retry").events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.deepEqual(ui.patches, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/2", "/notifications/threads/3"]);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("batch-counts").textContent, "");
  assert.equal(ui.ids.get("batch-error").textContent, "");
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
});

test("batch failure to reconnect is visible and never silently retries a mutation", async () => {
  const ui = await renderer();
  ui.setOffline(true);
  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.focusKey.startsWith("bulk:")).events.click();
  assert.equal(ui.ids.has("batch-confirm"), false);
  assert.match(ui.ids.get("notice").textContent, /Synthetic connection failure/);
  assert.equal(ui.patches.length, 0);
});

test("a group changed before the click is accepted reloads its count instead of marking a wider selection", async () => {
  const ui = await renderer();
  const oldButton = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository);
  assert.equal(oldButton.textContent, "Mark 1 as read");
  ui.inbox.pages[0].items.push({ ...ui.inbox.pages[0].items[0], id: "3", title: "Synthetic newcomer" });
  await oldButton.events.click();
  assert.deepEqual(ui.patches, []);
  assert.match(ui.ids.get("notice").textContent, /shown group changed/);
  const currentButton = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository);
  assert.equal(currentButton.textContent, "Mark 2 as read");
  assert.equal(currentButton.disabled, false);
});

test("stop remains usable during a long batch and the final successful request clears its controls quietly", async () => {
  let release;
  const ui = await renderer({
    onWrite: () => new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); }),
  });
  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository).events.click();
  await settle();
  assert.equal(ui.ids.get("batch-stop").hidden, false);
  ui.ids.get("batch-stop").focus();
  await ui.ids.get("batch-stop").events.click();
  assert.equal(ui.inbox.batch.snapshot().status, "stopping");
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("batch-title").textContent, "");
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
});

test("local status polling preserves keyboard focus on row and repository read controls", async () => {
  const ui = await renderer();
  for (const key of ["read:1", "bulk:example/widgets"]) {
    const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.focusKey === key);
    button.focus();
    assert.equal(ui.document.activeElement, button);
    await ui.fireTimer();
    assert.equal(ui.calls.at(-1).path, "/api/state");
    assert.equal(button.disabled, false);
    assert.equal(ui.document.activeElement, button);
  }
});

test("a row action clicked during a delayed local poll runs after the poll instead of being dropped", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2")],
    onState: () => new Promise(resolve => { release = resolve; }),
  });
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  button.focus();
  const polling = ui.fireTimer();
  await settle();
  assert.equal(button.disabled, false);
  assert.equal(ui.document.activeElement, button);
  const reading = button.events.click();
  await button.events.click();
  assert.equal(button.disabled, true);
  assert.equal(ui.document.activeElement, ui.document.body);
  assert.deepEqual(ui.patches, []);
  release();
  await polling;
  await reading;
  assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal(ui.document.activeElement.dataset.focusKey, "read:2");
  assert.equal(ui.document.activeElement.disabled, false);
});

test("a repository action clicked during local polling is not dropped and cannot receive a stale poll response afterward", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2")],
    onState: () => new Promise(resolve => { release = resolve; }),
  });
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository);
  button.focus();
  const polling = ui.fireTimer();
  await settle();
  assert.equal(button.disabled, false);
  const reading = button.events.click();
  assert.deepEqual(ui.patches, []);
  release();
  await polling;
  await reading;
  await ui.inbox.batch.done;
  const finalPoll = runInContext("update()", ui.context);
  await settle();
  release();
  await finalPoll;
  assert.deepEqual(ui.patches, ["/notifications/threads/1", "/notifications/threads/2"]);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("notice").hidden, true);
});

test("search edits during a row write are preserved on success and failure, with the latest edit winning", async () => {
  for (const success of [true, false]) {
    let release;
    const ui = await renderer({
      initialRows: [thread("1"), thread("2"), thread("3")],
      onWrite: () => new Promise(resolve => { release = () => resolve(success ? "HTTP/2 205 Reset Content\r\n\r\n" : http({}, {}, 403)); }),
    });
    const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
    const reading = button.events.click();
    await settle();
    const search = ui.ids.get("search");
    search.focus();
    search.value = "notification 2";
    search.events.input();
    await ui.fireTimer(250);
    search.value = "notification 3";
    search.events.input();
    release();
    await reading;
    await settle();
    assert.equal(search.value, "notification 3");
    assert.equal(ui.inbox.filters.query, "notification 3");
    assert.equal(ui.document.querySelectorAll("article").length, 1);
    assert.equal(ui.document.querySelectorAll("a")[0].textContent, "Synthetic notification 3");
    assert.deepEqual(ui.calls.filter(call => call.path === "/api/filters").map(call => JSON.parse(call.options.body).query), ["notification 3"]);
    assert.equal(ui.document.activeElement, search);
    assert.equal(ui.ids.get("notice").hidden, success);
  }
});

test("a search debounce already pending before a read is flushed after the read", async () => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  const search = ui.ids.get("search");
  search.value = "notification 2";
  search.events.input();
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  await button.events.click();
  await settle();
  assert.equal(ui.inbox.filters.query, "notification 2");
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal([...ui.timers.values()].some(timer => timer.delay === 250), false);
});

test("pending search is retained while a repository batch runs", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2", { repository: { full_name: "example/other" } })],
    onWrite: () => new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); }),
  });
  const search = ui.ids.get("search");
  search.value = "other";
  search.events.input();
  const group = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository === "example/widgets");
  await group.events.click();
  await settle();
  await ui.fireTimer(250);
  assert.equal(search.disabled, true);
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  await settle();
  assert.equal(search.disabled, false);
  assert.equal(search.value, "other");
  assert.equal(ui.inbox.filters.query, "other");
  assert.equal(ui.document.querySelectorAll("article").length, 1);
});

test("newer queued queries replace older edits while waiting for a local poll", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2"), thread("3")],
    onState: () => new Promise(resolve => { release = resolve; }),
  });
  const polling = ui.fireTimer();
  await settle();
  const filtering = runInContext('update("filters", { query: "notification 2" })', ui.context);
  const search = ui.ids.get("search");
  search.value = "notification 3";
  search.events.input();
  release();
  await polling;
  await filtering;
  assert.deepEqual(ui.calls.filter(call => call.path === "/api/filters").map(call => JSON.parse(call.options.body).query), ["notification 3"]);
  assert.equal(ui.inbox.filters.query, "notification 3");
});

test("rapid edits during an in-flight filter cannot apply an older query after a newer one", async () => {
  let release;
  let filtered = 0;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2"), thread("3")],
    onFilters: async () => {
      if (++filtered === 1) await new Promise(resolve => { release = resolve; });
    },
  });
  const filtering = runInContext('update("filters", { query: "notification 1" })', ui.context);
  await settle();
  const search = ui.ids.get("search");
  search.focus();
  search.value = "notification 2";
  search.events.input();
  search.value = "notification 3";
  search.events.input();
  release();
  await filtering;
  await settle();
  assert.deepEqual(ui.calls.filter(call => call.path === "/api/filters").map(call => JSON.parse(call.options.body).query),
    ["notification 1", "notification 3"]);
  assert.equal(ui.inbox.filters.query, "notification 3");
});

test("necessary disables restore focus after success or failure without stealing a user's new focus", async () => {
  for (const moveFocus of [false, true]) {
    let release;
    let requests = 0;
    const ui = await renderer({ onFetch: () => ++requests === 1 ? http([thread()]) :
      new Promise(resolve => { release = () => resolve(http([thread()])); }) });
    const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
    button.focus();
    ui.advance();
    const refreshing = ui.fireTimer();
    await settle();
    assert.equal(button.disabled, true);
    assert.equal(ui.document.activeElement, ui.document.body);
    if (moveFocus) ui.ids.get("search").focus();
    release();
    await refreshing;
    assert.equal(button.disabled, false);
    assert.equal(ui.document.activeElement, moveFocus ? ui.ids.get("search") : button);
  }
  const failed = await renderer({ readFailure: true });
  const button = failed.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  button.focus();
  await button.events.click();
  assert.equal(button.disabled, false);
  assert.equal(failed.document.activeElement, button);
});

test("a failed filter request retains the latest text and retries on a later local poll", async () => {
  let fail = true;
  const ui = await renderer({ initialRows: [thread("1"), thread("2")], onFilters: async () => {
    if (fail) throw new Error("Synthetic filter connection failure");
  } });
  const search = ui.ids.get("search");
  search.focus();
  search.value = "notification 2";
  search.events.input();
  await ui.fireTimer(250);
  assert.equal(ui.inbox.filters.query, "");
  assert.equal(search.value, "notification 2");
  assert.equal(ui.ids.get("notice").hidden, false);
  fail = false;
  await ui.fireTimer();
  assert.equal(ui.inbox.filters.query, "notification 2");
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal(ui.document.activeElement, search);
});

test("a queued filter survives becoming hidden before a local poll settles", async () => {
  let release;
  let hold = true;
  const ui = await renderer({ onState: async () => {
    if (hold) await new Promise(resolve => { release = resolve; });
  } });
  const polling = ui.fireTimer();
  await settle();
  const filtering = runInContext('update("filters", { query: "no match" })', ui.context);
  ui.intersect(false);
  release();
  await polling;
  await filtering;
  assert.equal(ui.inbox.filters.query, "");
  hold = false;
  ui.intersect(true);
  await settle();
  assert.equal(ui.inbox.filters.query, "no match");
  assert.equal(ui.document.querySelectorAll("article").length, 0);
});
