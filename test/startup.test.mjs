import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Startup, STARTUP_INSTANCE, claimStartup } from "../src/startup.mjs";

const notificationPanel = {
  canvasId: "github-notifications", extensionId: "user:github-notifications", instanceId: "manual-notifications",
};
const otherPanel = {
  canvasId: "agentcorp-observer", extensionId: "user:agentcorp-extension", instanceId: "office-startup",
};
const canvasEvents = ["session.canvas.opened", "session.canvas.closed", "session.canvas.recorded", "session.canvas.removed"];

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

test("startup's own open events do not cancel its in-flight attempt", async () => {
  const item = fixture();
  const open = item.session.rpc.canvas.open;
  item.session.rpc.canvas.open = async input => {
    for (const type of ["session.canvas.recorded", "session.canvas.opened"]) {
      item.emit({ type, data: { ...notificationPanel, instanceId: STARTUP_INSTANCE } });
      assert.equal(item.startup.stopped, false, type);
    }
    return open(input);
  };
  await item.startup.start();
  assert.equal(item.startup.status, "opened");
  assert.equal(item.opened.length, 1);
});

test("resumes, active histories and existing notification panels do not cause duplicate opens", async () => {
  for (const type of ["session.resume", "assistant.turn_start", "assistant.message", ...canvasEvents]) {
    const item = fixture({ events: [{ type: "session.start" }, { type, data: notificationPanel }] });
    await item.startup.start();
    assert.equal(item.opened.length, 0, type);
  }
  for (const instanceId of [notificationPanel.instanceId, STARTUP_INSTANCE]) {
    const existing = fixture({ panels: [otherPanel, { ...notificationPanel, instanceId }] });
    await existing.startup.start();
    assert.equal(existing.startup.status, "panel-already-open");
    assert.equal(existing.opened.length, 0);
  }
});

test("other canvases in history or already open do not block startup", async () => {
  for (const type of [undefined, ...canvasEvents]) {
    const events = [{ type: "session.start" }];
    if (type) events.push({ type, data: otherPanel });
    const item = fixture({ events, panels: [otherPanel] });
    await item.startup.start();
    assert.equal(item.startup.status, "opened", type);
    assert.equal(item.opened.length, 1, type);
  }
});

test("other canvas activity while waiting for the renderer does not cancel startup", async () => {
  for (const type of canvasEvents) {
    const item = fixture({ renderer: false, panels: [otherPanel] });
    await item.startup.start();
    item.emit({ type, data: otherPanel });
    assert.equal(item.startup.status, "waiting-for-renderer", type);
    item.session.capabilities.ui.canvases = true;
    item.emit({ type: "capabilities.changed" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(item.startup.status, "opened", type);
    assert.equal(item.opened.length, 1, type);
  }
});

test("another canvas opening during the final panel check does not cancel startup", async () => {
  const item = fixture();
  item.session.rpc.canvas.listOpen = async () => {
    item.emit({ type: "session.canvas.recorded", data: otherPanel });
    item.emit({ type: "session.canvas.opened", data: otherPanel });
    return { openCanvases: [otherPanel] };
  };
  await item.startup.start();
  assert.equal(item.startup.status, "opened");
  assert.equal(item.opened.length, 1);
});

test("notification activity while waiting still cancels startup", async () => {
  for (const type of canvasEvents) {
    const item = fixture({ renderer: false });
    await item.startup.start();
    item.emit({ type, data: notificationPanel });
    item.session.capabilities.ui.canvases = true;
    item.emit({ type: "capabilities.changed" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(item.startup.status, "session-already-active", type);
    assert.equal(item.opened.length, 0, type);
  }
});

test("a late renderer capability can open once, but disabling or starting work while waiting cancels it", async () => {
  const item = fixture({ renderer: false });
  await item.startup.start();
  assert.equal(item.startup.status, "waiting-for-renderer");
  item.session.capabilities.ui.canvases = true;
  item.emit({ type: "capabilities.changed" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.opened.length, 1);
  for (const cancel of ["disable", "session.resume", "session.canvas.closed", "session.canvas.removed", "assistant.turn_start"]) {
    const waiting = fixture({ renderer: false });
    await waiting.startup.start();
    if (cancel === "disable") waiting.preference.autoOpen = false;
    else waiting.emit({ type: cancel, data: { ...notificationPanel, instanceId: STARTUP_INSTANCE } });
    waiting.session.capabilities.ui.canvases = true;
    waiting.emit({ type: "capabilities.changed" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waiting.opened.length, 0);
  }
});

test("the session marker prevents reopening after close or provider reload, including when initially off", async t => {
  const directory = await mkdtemp(join(tmpdir(), "notification-startup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const enabled of [false, true]) {
    const initial = fixture({ enabled, panels: [otherPanel] });
    initial.session.workspacePath = join(directory, String(enabled));
    initial.startup.claim = claimStartup;
    await initial.startup.start();
    assert.equal(initial.opened.length, enabled ? 1 : 0);
    const reload = fixture();
    reload.session.workspacePath = initial.session.workspacePath;
    reload.startup.claim = claimStartup;
    await reload.startup.start();
    assert.equal(reload.startup.status, "already-checked");
    assert.equal(reload.opened.length, 0);
  }
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
