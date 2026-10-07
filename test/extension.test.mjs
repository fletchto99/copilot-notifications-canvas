import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { register, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { host, CanvasError } from "./fixtures/sdk.mjs";
import { http, next, thread } from "./fixtures.mjs";
import { filterSchema, emptySchema, InboxError } from "../.github/extensions/github-notifications/model.mjs";
import { Inbox } from "../.github/extensions/github-notifications/inbox.mjs";
import { CURRENT_VERSION } from "../.github/extensions/github-notifications/updates.mjs";

test("the extension entry point wires an isolated session through its complete lifecycle", async t => {
  const home = await fs.mkdtemp(join(tmpdir(), "notification-extension-"));
  const previousHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  const logs = [];
  const calls = [];
  const opens = [];
  const exits = [];
  const signals = ["SIGTERM", "SIGINT", "disconnect"];
  const oldListeners = new Map(signals.map(signal => [signal, process.listeners(signal)]));
  let shutdown;
  let holdRelease = false;
  let releaseSignal;
  t.mock.method(process, "exit", code => exits.push(code));
  t.after(async () => {
    try {
      await shutdown?.();
    } finally {
      for (const signal of signals) {
        for (const listener of process.listeners(signal)) {
          if (!oldListeners.get(signal).includes(listener)) process.removeListener(signal, listener);
        }
      }
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (previousHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previousHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    assert.equal(command, "gh");
    assert.equal(args[args.indexOf("--method") + 1], "GET", "Agent actions must never mark notifications read");
    calls.push(args);
    const endpoint = args.at(-1);
    let response;
    if (endpoint.endsWith("/releases/latest")) {
      if (holdRelease) {
        releaseSignal = options.signal;
        options.signal.addEventListener("abort", () => callback(new Error("Synthetic abort"), "", ""), { once: true });
        return;
      }
      response = http({ tag_name: `v${CURRENT_VERSION}`, draft: false, prerelease: false });
    } else if (new URL(endpoint, "https://api.github.com").pathname === "/notifications" &&
        new URL(endpoint, "https://api.github.com").searchParams.get("page") === "1") {
      response = http([thread("1")], { link: next });
    } else if (endpoint.includes("page=2")) {
      response = http([thread("2")]);
    } else {
      throw new Error(`Unexpected GitHub endpoint: ${endpoint}`);
    }
    queueMicrotask(() => callback(null, response, ""));
  });
  syncBuiltinESMExports();
  const artifacts = join(home, "extensions", "github-notifications", "artifacts");
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(join(artifacts, "settings.json"), '{"autoOpen":true,"darkMode":false}');
  host.session = {
    workspacePath: join(home, "session"),
    capabilities: { ui: { canvases: true } },
    log: (message, options) => logs.push({ message, options }),
    on: () => () => {},
    getEvents: async () => [{ type: "session.start", data: {} }],
    rpc: { canvas: {
      listOpen: async () => ({ openCanvases: [] }),
      open: async input => {
        opens.push(input);
        return host.registration.canvases[0].open(input);
      },
    } },
  };
  register(new URL("./fixtures/sdk-loader.mjs", import.meta.url));
  await import("../.github/extensions/github-notifications/extension.mjs");
  shutdown = process.listeners("SIGTERM").find(listener => !oldListeners.get("SIGTERM").includes(listener));
  const canvas = host.registration.canvases[0];
  const invoke = (name, instanceId, input = {}) =>
    canvas.actions.find(action => action.name === name).handler({ instanceId, input });

  await t.test("registration and auto-open use the expected schemas and read-only actions", async () => {
    assert.equal(host.registration.canvases.length, 1);
    assert.equal(canvas.id, "github-notifications");
    assert.equal(canvas.inputSchema, filterSchema);
    assert.deepEqual(canvas.actions.map(action => action.name).sort(),
      ["check_for_updates", "get_settings", "get_state", "load_more", "refresh", "set_filters"]);
    for (const action of canvas.actions) {
      assert.equal(typeof action.handler, "function");
      assert.equal(action.inputSchema, action.name === "set_filters" ? filterSchema : emptySchema);
    }
    assert.deepEqual(opens, [{ canvasId: "github-notifications", instanceId: "unread-notifications-startup", input: {} }]);
    const { desktopStatus, ...settings } = await invoke("get_settings", "unread-notifications-startup");
    assert.deepEqual(settings,
      { autoOpen: true, darkMode: false, desktopNotifications: false, desktopSound: "default", groupBy: "repo", startupStatus: "opened" });
    assert.equal(desktopStatus.state, "off");
    assert.equal(desktopStatus.platform, process.platform);
    assert.equal(desktopStatus.supported, true);
    assert.equal(calls.length, 0);
    await canvas.onClose({ instanceId: "unread-notifications-startup" });
    for (const signal of signals) {
      assert.equal(process.listeners(signal).length, oldListeners.get(signal).length + 1);
      assert.ok(process.listeners(signal).includes(shutdown));
    }
  });

  let first;
  let second;
  await t.test("concurrent repeated opens share a server while different panels remain isolated", async () => {
    const repeated = await Promise.all([canvas.open({ instanceId: "one" }), canvas.open({ instanceId: "one" })]);
    [first] = repeated;
    assert.deepEqual(repeated[0], repeated[1]);
    second = await canvas.open({ instanceId: "two", input: {} });
    assert.notEqual(first.url, second.url);
    for (const entry of [first, second]) {
      assert.equal(new URL(entry.url).hostname, "127.0.0.1");
      assert.equal((await fetch(entry.url)).status, 200);
    }
    assert.equal((await invoke("get_state", "one")).loaded, 0);
  });

  await t.test("all agent actions route correctly without returning notification content", async () => {
    assert.equal((await invoke("refresh", "one")).loaded, 1);
    assert.equal((await invoke("load_more", "one")).loaded, 2);
    const filtered = await invoke("set_filters", "one", { query: "notification 2" });
    assert.equal(filtered.matching, 1);
    assert.equal(filtered.searchActive, true);
    assert.doesNotMatch(JSON.stringify(filtered), /Synthetic|example\/widgets|notification 2/);
    assert.deepEqual(await invoke("get_state", "one"), filtered);
    assert.equal((await invoke("check_for_updates", "one")).status, "current");
    await assert.rejects(invoke("get_state", "missing"), error => error instanceof CanvasError && error.code === "not_open");
    await assert.rejects(invoke("set_filters", "one", { mode: "all" }), { code: "invalid_filters" });
  });

  await t.test("unexpected action errors are sanitized and logged", async subtest => {
    subtest.mock.method(Inbox.prototype, "summary", () => { throw new Error("Synthetic private detail"); });
    await assert.rejects(invoke("get_state", "one"), { code: "internal_error", message: "Unexpected inbox error. Inspect the extension log." });
    assert.deepEqual(logs.at(-1), { message: "Unexpected notifications action failure.", options: { level: "error" } });
    assert.doesNotMatch(JSON.stringify(logs), /Synthetic private detail/);
  });

  await t.test("failed opens report errors and allow a later retry", async subtest => {
    await assert.rejects(canvas.open({ instanceId: "invalid", input: { mode: "all" } }), { code: "invalid_filters" });
    const readFile = fs.readFile;
    const mocked = subtest.mock.method(fs, "readFile", (path, ...args) => {
      if (path instanceof URL && path.pathname.endsWith("/index.html")) throw new Error("Synthetic private path");
      return readFile(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(canvas.open({ instanceId: "retry" }), { code: "server_start", message: "Could not start the local notifications server." });
      assert.equal(logs.at(-1).message, "Could not start the notifications loopback server.");
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    const retried = await canvas.open({ instanceId: "retry" });
    assert.equal((await fetch(retried.url)).status, 200);
    await canvas.onClose({ instanceId: "retry" });
  });

  await t.test("closing panels is idempotent and clears shared caches only after the last close", async () => {
    await canvas.onClose({ instanceId: "one" });
    await canvas.onClose({ instanceId: "one" });
    await assert.rejects(fetch(first.url));
    assert.equal((await fetch(second.url)).status, 200);
    const before = calls.length;
    await invoke("refresh", "two");
    assert.equal(calls.length, before, "The remaining panel should reuse the shared cache");
    await canvas.onClose({ instanceId: "two" });
    await assert.rejects(fetch(second.url));
    first = await canvas.open({ instanceId: "shutdown" });
    await invoke("refresh", "shutdown");
    assert.equal(calls.length, before + 1, "The last close must clear the client cache");
  });

  await t.test("shutdown aborts release checks and closes all listeners before exiting", async () => {
    holdRelease = true;
    const pending = invoke("check_for_updates", "shutdown");
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(releaseSignal);
    await shutdown();
    await pending;
    assert.equal(releaseSignal.aborted, true);
    await assert.rejects(fetch(first.url));
    await assert.rejects(invoke("get_state", "shutdown"), { code: "not_open" });
    assert.deepEqual(exits, [0]);
  });
});

const source = await fs.readFile(new URL("../.github/extensions/github-notifications/extension.mjs", import.meta.url), "utf8");

async function fixture() {
  let canvas;
  let desktop;
  const servers = [];
  const inboxes = [];
  const session = { log() {} };
  class CanvasError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  await runInNewContext(`(async () => { ${source.replace(/^import .+;$/gm, "")} })()`, {
    joinSession: async () => session,
    createCanvas: value => { canvas = value; return value; },
    CanvasError, InboxError, emptySchema: {}, filterSchema: {},
    Preferences: class {},
    Updates: class {},
    GitHubClient: class { clear() {} },
    Inbox: class {
      constructor() { this.closed = false; inboxes.push(this); }
      close() { this.closed = true; }
    },
    DesktopNotifications: class {
      constructor() { desktop = this; this.panels = new Set(); }
      add(id) { this.panels.add(id); }
      async remove(id) { this.panels.delete(id); }
    },
    Startup: class { async start() {} },
    startServer: () => new Promise((resolve, reject) => {
      const server = { url: `http://127.0.0.1:${1000 + servers.length}/`, closed: false,
        async close() { this.closed = true; } };
      servers.push({ server, ready: () => resolve(server), reject });
    }),
    process: { once() {} },
  });
  return { canvas, desktop, servers, inboxes };
}

test("concurrent opens use one server and closing during startup cannot leave a desktop watcher", async () => {
  const f = await fixture();
  const one = f.canvas.open({ instanceId: "panel", input: {} });
  const two = f.canvas.open({ instanceId: "panel", input: {} });
  assert.equal(f.servers.length, 1);
  const closing = f.canvas.onClose({ instanceId: "panel" });
  const rejected = Promise.all([assert.rejects(one, { code: "closed" }), assert.rejects(two, { code: "closed" })]);
  f.servers[0].ready();
  await rejected;
  await closing;
  assert.equal(f.desktop.panels.size, 0);
  assert.equal(f.servers[0].server.closed, true);
});

test("a closing old open cannot delete or unregister a replacement panel with the same ID", async () => {
  const f = await fixture();
  const old = f.canvas.open({ instanceId: "panel", input: {} });
  const rejected = assert.rejects(old, { code: "closed" });
  const closing = f.canvas.onClose({ instanceId: "panel" });
  const replacement = f.canvas.open({ instanceId: "panel", input: {} });
  f.servers[1].ready();
  await replacement;
  f.servers[0].ready();
  await rejected;
  await closing;
  assert.equal(f.desktop.panels.has("panel"), true);
  assert.equal(f.servers[1].server.closed, false);
  await f.canvas.onClose({ instanceId: "panel" });
  assert.equal(f.desktop.panels.size, 0);
  assert.equal(f.servers[1].server.closed, true);
});

test("a failed server releases inbox resources and never starts desktop watching", async () => {
  const f = await fixture();
  const opening = f.canvas.open({ instanceId: "panel", input: {} });
  const rejected = assert.rejects(opening, { code: "server_start" });
  f.servers[0].reject(new Error("Synthetic bind failure"));
  await rejected;
  assert.equal(f.inboxes[0].closed, true);
  assert.equal(f.desktop.panels.size, 0);
});
