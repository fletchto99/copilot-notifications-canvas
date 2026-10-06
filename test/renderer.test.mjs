import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { Inbox } from "../.github/extensions/github-notifications/inbox.mjs";
import { GitHubClient } from "../.github/extensions/github-notifications/github.mjs";
import { NotificationSound } from "../.github/extensions/github-notifications/sound.mjs";
import { http, thread } from "./fixtures.mjs";
import { FakeAudioContext } from "./audio-fixtures.mjs";

const script = await readFile(new URL("../.github/extensions/github-notifications/app.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("../.github/extensions/github-notifications/index.html", import.meta.url), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

// Minimal DOM/event/timer doubles exercise the actual renderer without a browser dependency.
async function renderer({ hidden = false, token = "a".repeat(64), audioOptions = {}, readFailure = false,
  initialRows, onWrite, onFetch, onState, onFilters, initialOffline = false } = {}) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  let intersect;
  let now = Date.now();
  let offline = initialOffline;
  let rows = initialRows ?? [
    thread("1", { subject: { title: "<img src=x onerror=alert(1)>", type: "Issue", url: null } }),
    thread("2", { unread: false }),
  ];
  const audioContexts = [];
  let storedAutoOpen = false;
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
  ids.get("settings").contains = node => ["settings", "settings-toggle", "settings-panel", "sound", "auto-open"].some(id => ids.get(id) === node);
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
  window.AudioContext = class extends FakeAudioContext {
    constructor() { super(audioOptions); audioContexts.push(this); }
  };
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
    Date: class extends Date { static now() { return now; } },
    NotificationSound: class extends NotificationSound {
      constructor(options) { super({ ...options, now: () => now }); }
    },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    IntersectionObserver: class {
      constructor(callback) { intersect = callback; }
      observe() {}
      disconnect() {}
    },
    fetch: async (path, options) => {
      if (offline) throw new Error("Synthetic connection failure");
      calls.push({ path, options });
      if (path === "/api/settings") {
        if (options.body) storedAutoOpen = JSON.parse(options.body).autoOpen;
        return { ok: true, json: async () => ({ autoOpen: storedAutoOpen }) };
      }
      if (path === "/api/refresh") await inbox.refresh();
      if (path === "/api/state") {
        const snapshot = inbox.snapshot();
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
      return { ok: true, json: async () => inbox.snapshot() };
    },
  });
  assert.match(script, /^import \{ NotificationSound \} from "\.\/sound\.mjs";/);
  runInContext(script.replace(/^import \{ NotificationSound \} from "\.\/sound\.mjs";/, ""), context);
  await settle();
  return {
    calls, document, window, ids, timers, context, audioContexts, inbox, patches, githubCalls,
    advance(milliseconds = 120_000) { now += milliseconds; return now; },
    async fireTimer(delay = 5000) {
      const [id, timer] = [...timers].find(([, timer]) => timer.delay === delay);
      timers.delete(id);
      await timer.fn();
      await settle();
    },
    setRows(value) { rows = value; },
    setOffline(value) { offline = value; },
    intersect: value => intersect([{ isIntersecting: value }]),
  };
}

test("renderer fetches with a capability, renders untrusted titles as text and exposes accessible controls", async () => {
  const ui = await renderer();
  assert.equal(ui.calls[0].path, "/api/refresh");
  assert.equal(ui.calls[0].options.headers.Authorization, `Bearer ${"a".repeat(64)}`);
  assert.equal(ui.calls[0].options.credentials, "omit");
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
  assert.equal(ui.calls[0].path, "/api/refresh");
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
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.timers.size, 1);
  ui.intersect(false);
  await settle();
  assert.equal(ui.timers.size, 0);
  await runInContext("tick()", ui.context);
  assert.equal(ui.calls.length, 1);
  ui.intersect(true);
  await settle();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.calls[1].path, "/api/state");
  ui.window.events.pagehide();
  assert.equal(ui.timers.size, 0);
  await runInContext("tick()", ui.context);
  assert.equal(ui.calls.length, 2);
});

test("a missing capability remains inert and explains how to open the canvas", async () => {
  const ui = await renderer({ token: "" });
  ui.intersect(true);
  ui.document.events.visibilitychange();
  await settle();
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.timers.size, 0);
  assert.match(ui.ids.get("notice").textContent, /Open this canvas from Copilot/);
});

test("sound is opt-in and refresh arrivals ring once even when search hides every row", async () => {
  const ui = await renderer();
  assert.equal(ui.audioContexts.length, 0);
  assert.match(html, /id="sound"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(html, /id="sound-status"[^>]*role="status"/);
  ui.ids.get("sound").events.click();
  await settle();
  assert.equal(ui.ids.get("sound").attributes["aria-checked"], "true");
  assert.equal(ui.ids.get("sound").textContent, "Play sound: On");
  assert.equal(ui.audioContexts[0].starts, 0);
  await runInContext('update("filters", { query: "no match" })', ui.context);
  const later = ui.advance();
  ui.setRows([thread("3", { updated_at: new Date(later).toISOString() })]);
  await runInContext('update("refresh", {})', ui.context);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.audioContexts[0].starts, 1);
  await runInContext('update("refresh", {})', ui.context);
  await runInContext('update("filters", { query: "" })', ui.context);
  assert.equal(ui.audioContexts[0].starts, 1);
  ui.ids.get("sound").events.click();
  await settle();
  assert.equal(ui.ids.get("sound").attributes["aria-checked"], "false");
  assert.equal(ui.audioContexts[0].state, "closed");
});

test("visible toggle reports browser audio failures, and pagehide closes its context", async () => {
  const failed = await renderer({ audioOptions: { resumeError: true } });
  failed.ids.get("sound").events.click();
  await settle();
  assert.equal(failed.ids.get("sound").textContent, "Play sound: Off");
  assert.match(failed.ids.get("sound-status").textContent, /could not be enabled/);
  const ui = await renderer();
  ui.ids.get("sound").events.click();
  await settle();
  ui.window.events.pagehide();
  await settle();
  assert.equal(ui.audioContexts[0].state, "closed");
  assert.equal(ui.ids.get("sound").attributes["aria-checked"], "false");
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

test("Settings contains both switches, saves startup preference and closes accessibly", async () => {
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
  assert.match(ui.ids.get("settings-status").textContent, /future new sessions/);
  ui.document.events.click({ target: ui.ids.get("sound") });
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
  assert.equal(ui.audioContexts.length, 0);
});

test("settings failures are visible and do not claim a saved toggle", async () => {
  const ui = await renderer();
  ui.setOffline(true);
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  assert.equal(ui.ids.get("auto-open").disabled, true);
  assert.match(ui.ids.get("settings-status").textContent, /retry/);
  ui.setOffline(false);
  ui.ids.get("settings").events.toggle();
  await settle();
  assert.equal(ui.ids.get("auto-open").disabled, false);
});

test("mark-read requires a click, removes only on confirmation and stays silent", async () => {
  const ui = await renderer();
  assert.equal(ui.calls.some(call => call.path === "/api/read"), false);
  ui.ids.get("sound").events.click();
  await settle();
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  assert.match(button.attributes["aria-label"], /Mark as read/);
  button.focus();
  const marking = button.events.click();
  assert.equal(button.disabled, true);
  await button.events.click();
  await marking;
  assert.equal(ui.calls.filter(call => call.path === "/api/read").length, 1);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.audioContexts[0].starts, 0);
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

test("hidden views and reconnects reset the audio baseline without catch-up chimes", async () => {
  const ui = await renderer();
  ui.ids.get("sound").events.click();
  await settle();
  ui.intersect(false);
  const later = ui.advance();
  ui.setRows([thread("3", { updated_at: new Date(later).toISOString() })]);
  await runInContext('update("refresh", {})', ui.context);
  assert.equal(ui.audioContexts[0].starts, 0);
  ui.intersect(true);
  await settle();
  await runInContext('update("refresh", {})', ui.context);
  assert.equal(ui.audioContexts[0].starts, 0);
  ui.setOffline(true);
  await runInContext('update("refresh", {})', ui.context);
  ui.setOffline(false);
  const newest = ui.advance();
  ui.setRows([thread("4", { updated_at: new Date(newest).toISOString() })]);
  await runInContext('update("refresh", {})', ui.context);
  assert.equal(ui.audioContexts[0].starts, 0);
  ui.window.events.pagehide();
  await settle();
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
  ui.ids.get("sound").events.click();
  await settle();
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
  assert.equal(ui.audioContexts[0].starts, 0);
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
