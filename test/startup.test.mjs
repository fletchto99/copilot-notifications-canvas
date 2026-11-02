import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
const setupResume = { type: "session.resume", data: { sessionWasActive: false } };
const setupHistory = [{ type: "session.start" }, { type: "session.shutdown" }, setupResume];

function fixture({ enabled = true, renderer = true, events = [{ type: "session.start" }],
  canvases = [notificationPanel], panels = [], failOpen = false } = {}) {
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
      list: async () => ({ canvases }),
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
  assert.deepEqual(on.opened, [{
    extensionId: notificationPanel.extensionId, canvasId: "github-notifications", instanceId: STARTUP_INSTANCE, input: {},
  }]);
  await on.startup.attempt();
  await on.startup.start();
  assert.equal(on.opened.length, 1);
});

test("configuration resumes before the first conversation activity still auto-open", async () => {
  const item = fixture({ events: setupHistory });
  await item.startup.start();
  assert.equal(item.startup.status, "opened");
  assert.equal(item.opened.length, 1);
  assert.deepEqual(item.logs, []);
});

test("setup resumes during history, provider or panel inspection do not cancel startup", async t => {
  for (const stage of ["history", "providers", "panels"]) {
    await t.test(stage, async () => {
      const item = fixture();
      const resume = result => async () => {
        item.emit(setupResume);
        return result;
      };
      if (stage === "history") item.session.getEvents = resume(setupHistory);
      else if (stage === "providers") item.session.rpc.canvas.list = resume({ canvases: [notificationPanel] });
      else item.session.rpc.canvas.listOpen = resume({ openCanvases: [] });
      await item.startup.start();
      assert.equal(item.startup.status, "opened");
      assert.equal(item.opened.length, 1);
    });
  }
});

test("setup resumes while waiting for the renderer can open once the renderer arrives", async () => {
  const item = fixture({ renderer: false });
  await item.startup.start();
  item.emit(setupResume);
  assert.equal(item.startup.status, "waiting-for-renderer");
  item.session.capabilities.ui.canvases = true;
  item.emit({ type: "capabilities.changed" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.startup.status, "opened");
  assert.equal(item.opened.length, 1);
});

test("resumes with conversation history, live work, pending work or unknown activity never auto-open", async () => {
  for (const type of ["user.message", "assistant.turn_start", "assistant.message", ...canvasEvents]) {
    for (const activity of [false, true, undefined]) {
      const item = fixture({ events: [
        { type: "session.start" }, { type, data: notificationPanel },
        { type: "session.resume", data: { sessionWasActive: activity } },
      ] });
      await item.startup.start();
      assert.equal(item.startup.status, "existing-session", `${type}: ${activity}`);
      assert.deepEqual(item.opened, []);
    }
  }
  for (const data of [{}, { sessionWasActive: true }, { sessionWasActive: false, continuePendingWork: true }]) {
    const item = fixture({ events: [{ type: "session.start" }, { type: "session.resume", data }] });
    await item.startup.start();
    assert.equal(item.startup.status, "existing-session");
    assert.deepEqual(item.opened, []);
  }
  const missingStart = fixture({ events: [setupResume] });
  await missingStart.startup.start();
  assert.equal(missingStart.startup.status, "existing-session");
  assert.deepEqual(missingStart.opened, []);
});

test("auto-open explicitly selects the project provider when both copies are registered", async () => {
  const project = { ...notificationPanel, extensionId: "project:github-notifications" };
  for (const canvases of [[notificationPanel, project], [project, notificationPanel], [project]]) {
    const item = fixture({ canvases: [otherPanel, ...canvases] });
    await item.startup.start();
    assert.equal(item.startup.status, "opened");
    assert.deepEqual(item.opened, [{
      extensionId: project.extensionId, canvasId: "github-notifications", instanceId: STARTUP_INSTANCE, input: {},
    }]);
  }
});

test("missing or ambiguous providers report a sanitized error instead of guessing", async () => {
  const renamed = { ...notificationPanel, extensionId: "user:another-copy" };
  for (const canvases of [[otherPanel], [notificationPanel, renamed]]) {
    const item = fixture({ canvases });
    await item.startup.start();
    assert.equal(item.startup.status, "error");
    assert.deepEqual(item.opened, []);
    assert.equal(item.logs.length, 1);
    assert.equal(item.logs[0][1].level, "warning");
    assert.equal(JSON.stringify(item.logs).includes(renamed.extensionId), false);
  }
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

test("starting work during inspection cancels auto-open even when the snapshot is still fresh", async t => {
  for (const stage of ["history", "providers", "panels"]) {
    for (const type of ["user.message", "assistant.turn_start", "assistant.message"]) {
      await t.test(`${stage}: ${type}`, async () => {
        const item = fixture();
        const activate = result => async () => {
          item.emit({ type });
          return result;
        };
        if (stage === "history") item.session.getEvents = activate([{ type: "session.start" }]);
        else if (stage === "providers") item.session.rpc.canvas.list = activate({ canvases: [notificationPanel] });
        else item.session.rpc.canvas.listOpen = activate({ openCanvases: [] });
        await item.startup.start();
        assert.equal(item.startup.status, "session-already-active");
        item.emit({ type: "capabilities.changed" });
        await item.startup.attempt();
        assert.deepEqual(item.opened, []);
        assert.deepEqual(item.logs, []);
      });
    }
  }
});

test("a resumed session discovered on the final history read never reaches the panel open RPC", async () => {
  const item = fixture();
  let reads = 0;
  item.session.getEvents = async () => ++reads === 1
    ? [{ type: "session.start" }]
    : [{ type: "session.start" }, { type: "session.resume" }];
  item.session.rpc.canvas.listOpen = async () => assert.fail("Active sessions must not continue to panel inspection");
  await item.startup.start();
  assert.equal(reads, 2);
  assert.equal(item.startup.status, "existing-session");
  assert.deepEqual(item.opened, []);
  assert.deepEqual(item.logs, []);
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
  for (const cancel of ["disable", "session.resume", "session.canvas.closed", "session.canvas.removed",
    "user.message", "assistant.turn_start", "assistant.message"]) {
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
    const reload = fixture({ events: setupHistory });
    reload.session.workspacePath = initial.session.workspacePath;
    reload.startup.claim = claimStartup;
    await reload.startup.start();
    assert.equal(reload.startup.status, "already-checked");
    assert.equal(reload.opened.length, 0);
  }
});

test("concurrent providers share the startup claim across setup resumes and later reloads", async t => {
  const directory = await mkdtemp(join(tmpdir(), "notification-startup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const items = Array.from({ length: 2 }, () => fixture({ events: setupHistory }));
  for (const item of items) {
    item.session.workspacePath = directory;
    item.startup.claim = claimStartup;
  }
  await Promise.all(items.map(item => item.startup.start()));
  assert.deepEqual(items.map(item => item.startup.status).sort(), ["already-checked", "opened"]);
  assert.equal(items.flatMap(item => item.opened).length, 1);
  const reload = fixture({ events: setupHistory });
  reload.session.workspacePath = directory;
  reload.startup.claim = claimStartup;
  await reload.startup.start();
  assert.equal(reload.startup.status, "already-checked");
  assert.deepEqual(reload.opened, []);
});

test("a missing session workspace reports one startup failure without opening or retrying", async () => {
  const item = fixture();
  item.session.workspacePath = undefined;
  item.startup.claim = claimStartup;
  await item.startup.start();
  await item.startup.start();
  await item.startup.attempt();
  assert.equal(item.startup.status, "error");
  assert.deepEqual(item.opened, []);
  assert.equal(item.logs.length, 1);
  assert.equal(item.logs[0][1].level, "warning");
});

test("startup marker I/O errors propagate and close handles without reopening an already-claimed session", async t => {
  for (const operation of ["open", "writeFile"]) {
    await t.test(operation, async t => {
      const directory = await mkdtemp(join(tmpdir(), "notification-startup-test-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const failure = Object.assign(new Error("Synthetic marker failure"), { code: "EACCES" });
      const open = fs.open;
      let handle;
      t.mock.method(fs, "open", async (...args) => {
        if (operation === "open") throw failure;
        handle = await open(...args);
        t.mock.method(handle, "writeFile", async () => { throw failure; });
        return handle;
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(claimStartup(directory), error => error === failure);
        if (operation === "writeFile") assert.equal(handle.fd, -1);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.equal(await claimStartup(directory), operation === "open");
      assert.equal(await claimStartup(directory), false);
    });
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
