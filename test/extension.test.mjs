import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { InboxError } from "../.github/extensions/github-notifications/model.mjs";

const source = await readFile(new URL("../.github/extensions/github-notifications/extension.mjs", import.meta.url), "utf8");

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
