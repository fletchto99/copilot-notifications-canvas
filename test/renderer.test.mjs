import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { Inbox } from "../.github/extensions/github-notifications/inbox.mjs";
import { GitHubClient } from "../.github/extensions/github-notifications/github.mjs";
import { http, thread } from "./fixtures.mjs";

const script = await readFile(new URL("../.github/extensions/github-notifications/app.mjs", import.meta.url), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

// Minimal DOM/event/timer doubles exercise the actual renderer without a browser dependency.
async function renderer({ hidden = false, token = "a".repeat(64) } = {}) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  let intersect;
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
    querySelectorAll(selector) {
      const result = [];
      for (const child of this.children) {
        if (child.tag === selector || (selector === "[data-focus-key]" && child.dataset.focusKey)) result.push(child);
        result.push(...child.querySelectorAll(selector));
      }
      return result;
    }
  }
  const ids = new Map();
  const document = {
    hidden,
    documentElement: new Node("html"),
    events: {},
    getElementById(id) {
      if (!ids.has(id)) ids.set(id, new Node(id));
      return ids.get(id);
    },
    createElement: tag => new Node(tag),
    createDocumentFragment: () => new Node("fragment"),
    querySelectorAll: selector => [...ids.values()].flatMap(node => node.querySelectorAll(selector)),
    addEventListener(name, handler) { this.events[name] = handler; },
  };
  const window = { events: {}, addEventListener(name, handler) { this.events[name] = handler; } };
  const inbox = new Inbox(new GitHubClient({ run: async args => http([
    thread("1", { subject: { title: "<img src=x onerror=alert(1)>", type: "Issue", url: null } }),
    ...(args.at(-1).includes("all=true") ? [thread("2", { unread: false })] : []),
  ]) }));
  const context = createContext({
    document, window, location: { hash: `#${token}` }, Intl, Date, AbortController,
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    IntersectionObserver: class {
      constructor(callback) { intersect = callback; }
      observe() {}
      disconnect() {}
    },
    fetch: async (path, options) => {
      calls.push({ path, options });
      if (path === "/api/refresh") await inbox.refresh();
      if (path === "/api/filters") await inbox.setFilters(JSON.parse(options.body));
      return { ok: true, json: async () => inbox.snapshot() };
    },
  });
  runInContext(script, context);
  await settle();
  return {
    calls, document, window, ids, timers, context,
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
  assert.equal(ui.ids.get("unread").attributes["aria-pressed"], "true");
  assert.equal(ui.ids.get("empty").hidden, true);
  assert.equal(ui.document.querySelectorAll("time")[0].attributes["aria-label"].length > 0, true);
  ui.ids.get("all").events.click();
  await settle();
  assert.equal(ui.document.querySelectorAll("article").length, 2);
  assert.equal(ui.ids.get("all").attributes["aria-pressed"], "true");
  assert.equal(ui.ids.get("api-limit").hidden, false);
  ui.ids.get("unread").events.click();
  await settle();
  assert.equal(ui.ids.get("api-limit").hidden, true);
});

test("All is the left-most mode control and Unread remains the default", async () => {
  const html = await readFile(new URL("../.github/extensions/github-notifications/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('id="all"') < html.indexOf('id="unread"'));
  assert.match(html, /id="unread"[^>]+aria-pressed="true"/);
  assert.match(html, /GitHub's API does not expose Done status/);
});

test("renderer preserves focus and collapsed groups across unchanged data and updates", async () => {
  const ui = await renderer();
  const firstLink = ui.document.querySelectorAll("a")[0];
  firstLink.focus();
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement, firstLink);
  const group = ui.document.querySelectorAll("details")[0];
  group.open = false;
  group.events.toggle();
  assert.equal(ui.ids.get("collapse").textContent, "Expand all");
  ui.ids.get("all").events.click();
  await settle();
  assert.equal(ui.document.querySelectorAll("details")[0].open, false);
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:1");
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
