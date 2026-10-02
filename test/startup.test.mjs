import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Startup, STARTUP_INSTANCE, claimStartup } from "../.github/extensions/github-notifications/startup.mjs";

function fixture({ enabled = true, renderer = true, events = [{ type: "session.start" }], panels = [], failOpen = false } = {}) {
  let handler;
  const opened = [];
  const logs = [];
  const preference = { autoOpen: enabled };
  const session = {
    workspacePath: "/synthetic/session",
    capabilities: { ui: { canvases: renderer } },
    getEvents: async () => events,
    on: callback => { handler = callback; return () => { handler = undefined; }; },
    log: async (...args) => logs.push(args),
    rpc: { canvas: {
      listOpen: async () => ({ openCanvases: panels }),
      open: async input => { if (failOpen) throw new Error("sensitive synthetic failure"); opened.push(input); },
    } },
  };
  const startup = new Startup(session, { read: async () => preference }, { claim: async () => true });
  return { startup, session, preference, opened, logs, emit: event => handler?.(event) };
}

test("startup is opt-in and uses the supported RPC with one stable instance", async () => {
  const off = fixture({ enabled: false });
  await off.startup.start();
  assert.equal(off.startup.status, "disabled");
  assert.equal(off.opened.length, 0);
  const on = fixture();
  await on.startup.start();
  assert.deepEqual(on.opened, [{ canvasId: "github-notifications", instanceId: STARTUP_INSTANCE, input: {} }]);
  await on.startup.attempt();
  await on.startup.start();
  assert.equal(on.opened.length, 1);
});

test("resumes, active histories and existing panels do not cause duplicate or focus-stealing opens", async () => {
  for (const type of ["session.resume", "assistant.turn_start", "assistant.message", "session.canvas.opened", "session.canvas.closed"]) {
    const item = fixture({ events: [{ type: "session.start" }, { type }] });
    await item.startup.start();
    assert.equal(item.opened.length, 0);
  }
  const existing = fixture({ panels: [{ instanceId: "already-open" }] });
  await existing.startup.start();
  assert.equal(existing.startup.status, "panel-already-open");
});

test("a late renderer capability can open once, but disabling or starting work while waiting cancels it", async () => {
  const item = fixture({ renderer: false });
  await item.startup.start();
  assert.equal(item.startup.status, "waiting-for-renderer");
  item.session.capabilities.ui.canvases = true;
  item.emit({ type: "capabilities.changed" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.opened.length, 1);
  for (const cancel of ["disable", "session.canvas.closed", "assistant.turn_start"]) {
    const waiting = fixture({ renderer: false });
    await waiting.startup.start();
    if (cancel === "disable") waiting.preference.autoOpen = false;
    else waiting.emit({ type: cancel, data: {} });
    waiting.session.capabilities.ui.canvases = true;
    waiting.emit({ type: "capabilities.changed" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waiting.opened.length, 0);
  }
});

test("the session marker prevents reopening after close or provider reload, including when initially off", async t => {
  const directory = await mkdtemp(join(tmpdir(), "notification-startup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const off = fixture({ enabled: false });
  off.session.workspacePath = directory;
  off.startup.claim = claimStartup;
  await off.startup.start();
  const reload = fixture();
  reload.session.workspacePath = directory;
  reload.startup.claim = claimStartup;
  await reload.startup.start();
  assert.equal(reload.startup.status, "already-checked");
  assert.equal(reload.opened.length, 0);
});

test("startup and storage failures log a sanitized warning and never loop", async () => {
  const failed = fixture({ failOpen: true });
  await failed.startup.start();
  assert.equal(failed.startup.status, "error");
  assert.equal(failed.logs.length, 1);
  assert.equal(JSON.stringify(failed.logs).includes("sensitive"), false);
  const storage = fixture();
  storage.startup.claim = async () => { throw new Error("permission failure"); };
  await storage.startup.start();
  assert.equal(storage.logs.length, 1);
  assert.equal(storage.opened.length, 0);
});
