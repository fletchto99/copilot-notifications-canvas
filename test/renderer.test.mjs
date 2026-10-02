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
async function renderer({ hidden = false, token = "a".repeat(64), audioOptions = {}, readFailure = false } = {}) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  let intersect;
  let now = Date.now();
  let offline = false;
  let rows = [
    thread("1", { subject: { title: "<img src=x onerror=alert(1)>", type: "Issue", url: null } }),
    thread("2", { unread: false }),
  ];
  const audioContexts = [];
  let storedAutoOpen = false;
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.events = {};
      this.textContent = "";
      this.value = "";
    }
    set innerHTML(_) { throw new Error("HTML interpolation is forbidden"); }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(fragment) { this.children = fragment.children; }
    addEventListener(name, handler) { this.events[name] = handler; }
    focus() { document.activeElement = this; }
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
  const ids = new Map([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)].map(([, tag, id]) => [id, new Node(tag)]));
  ids.get("settings").contains = node => ["settings", "settings-toggle", "settings-panel", "sound", "auto-open"].some(id => ids.get(id) === node);
  const document = {
    hidden,
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
  const inbox = new Inbox(new GitHubClient({ now: () => now, run: async args => {
    if (args.includes("PATCH")) return readFailure ? http({}, {}, 403) : "HTTP/2 205 Reset Content\r\n\r\n";
    return http(rows);
  } }));
  const context = createContext({
    document, window, location: { hash: `#${token}` }, Intl, Date, AbortController,
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
      if (path === "/api/filters") await inbox.setFilters(JSON.parse(options.body));
      if (path === "/api/read") await inbox.markRead(JSON.parse(options.body));
      return { ok: true, json: async () => inbox.snapshot() };
    },
  });
  assert.match(script, /^import \{ NotificationSound \} from "\.\/sound\.mjs";/);
  runInContext(script.replace(/^import \{ NotificationSound \} from "\.\/sound\.mjs";/, ""), context);
  await settle();
  return {
    calls, document, window, ids, timers, context, audioContexts,
    advance() { now += 120_000; return now; },
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
  assert.equal(ui.ids.get("empty").hidden, true);
  assert.equal(ui.document.querySelectorAll("time")[0].attributes["aria-label"].length > 0, true);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
});

test("canvas is titled Unread Notifications without mode tabs or the old All notice", () => {
  assert.match(html, /<title>Unread Notifications<\/title>/);
  assert.match(html, /<h1>Unread Notifications<\/h1>/);
  assert.doesNotMatch(html, /id="(?:all|unread|api-limit)"/);
});

test("renderer preserves focus and collapsed groups across unchanged data and updates", async () => {
  const ui = await renderer();
  const firstLink = ui.document.querySelectorAll("a")[0];
  firstLink.focus();
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement, firstLink);
  const group = ui.ids.get("groups").querySelectorAll("details")[0];
  group.open = false;
  group.events.toggle();
  assert.equal(ui.ids.get("collapse").textContent, "Expand all");
  await runInContext("state.groups[0].items[0].title = 'Updated synthetic title'; render()", ui.context);
  assert.equal(ui.ids.get("groups").querySelectorAll("details")[0].open, false);
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:1");
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
  const button = ui.ids.get("groups").querySelectorAll("button")[0];
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
  const button = ui.ids.get("groups").querySelectorAll("button")[0];
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
