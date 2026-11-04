import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Startup, STARTUP_INSTANCE, acquireStartupLock } from "../src/startup.mjs";

const notificationPanel = {
  canvasId: "github-notifications", extensionId: "user:github-notifications", instanceId: "manual-notifications",
};
const otherPanel = {
  canvasId: "agentcorp-observer", extensionId: "user:agentcorp-extension", instanceId: "office-startup",
};
const canvasEvents = ["session.canvas.opened", "session.canvas.closed", "session.canvas.recorded", "session.canvas.removed"];
const resumedHistory = [
  { type: "session.start" }, { type: "user.message" }, { type: "assistant.turn_start" },
  { type: "assistant.message" }, { type: "session.shutdown" }, { type: "session.resume" },
];

function fixture({ enabled = true, renderer = true, events = [{ type: "session.start" }],
  canvases = [notificationPanel], panels = [], failOpen = false } = {}) {
  const handlers = new Set();
  const opened = [];
  const logs = [];
  const timers = [];
  const preference = { autoOpen: enabled };
  const emit = event => {
    events.push(event);
    for (const handler of handlers) handler(event);
  };
  const session = {
    workspacePath: "/synthetic/session",
    capabilities: { ui: { canvases: renderer } },
    getEvents: async () => events,
    on: callback => { handlers.add(callback); return () => handlers.delete(callback); },
    log: async (...args) => logs.push(args),
    rpc: { canvas: {
      list: async () => ({ canvases }),
      listOpen: async () => ({ openCanvases: panels }),
      open: async input => {
        if (failOpen) throw new Error("sensitive synthetic failure");
        opened.push(input);
        panels.push(input);
        emit({ type: "session.canvas.recorded", data: input });
        emit({ type: "session.canvas.opened", data: input });
      },
    } },
  };
  const dependencies = {
    lock: async () => async () => {},
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel: timer => { timer.cancelled = true; },
  };
  const preferences = { read: async () => preference };
  const startup = new Startup(session, preferences, dependencies);
  const retry = async () => {
    const timer = timers.find(timer => !timer.cancelled && !timer.fired);
    assert.ok(timer, "Expected a scheduled retry");
    timer.fired = true;
    timer.callback();
    await startup.pending;
  };
  return { startup, session, preferences, dependencies, preference, opened, logs, timers, handlers, panels, events, emit, retry };
}

async function workspace(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), "notification-startup-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("startup is opt-in and does not react to preference changes in an already-running session", async () => {
  const off = fixture({ enabled: false });
  off.startup.lock = async () => assert.fail("Disabled startup must not write coordination files");
  await off.startup.start();
  assert.equal(off.startup.status, "disabled");
  assert.equal(off.handlers.size, 0);
  off.preference.autoOpen = true;
  off.emit({ type: "capabilities.changed" });
  await off.startup.start();
  await off.startup.attempt();
  assert.deepEqual(off.opened, []);

  const entered = new Startup(off.session, off.preferences, off.dependencies);
  await entered.start();
  assert.equal(entered.status, "opened", "Enabling applies when the session is next attached");
  assert.deepEqual(off.opened, [{
    extensionId: notificationPanel.extensionId, canvasId: "github-notifications", instanceId: STARTUP_INSTANCE, input: {},
  }]);
  assert.equal(off.handlers.size, 0);
});

test("new, resumed, active-history and restored sessions can open a missing undismissed panel", async () => {
  for (const events of [[], resumedHistory, [
    { type: "session.resume", data: { sessionWasActive: true, continuePendingWork: true } },
  ], [{ type: "session.canvas.recorded", data: notificationPanel }]]) {
    const item = fixture({ events: [...events] });
    await item.startup.start();
    assert.equal(item.startup.status, "opened");
    assert.equal(item.opened.length, 1);
    await item.startup.start();
    await item.startup.attempt();
    assert.equal(item.opened.length, 1, "There is no continuous keep-open loop");
  }
});

test("existing notification panels are left alone without resolving or focusing their provider", async () => {
  for (const instanceId of [notificationPanel.instanceId, STARTUP_INSTANCE]) {
    const item = fixture({ panels: [otherPanel, { ...notificationPanel, instanceId }] });
    item.session.rpc.canvas.list = async () => assert.fail("An existing panel needs no provider lookup");
    await item.startup.start();
    assert.equal(item.startup.status, "panel-already-open");
    assert.deepEqual(item.opened, []);
  }
});

test("legacy startup IDs preserve existing panels and dismissal history after resume", async () => {
  const legacy = { ...notificationPanel, instanceId: "unread-notifications-startup" };
  const existing = fixture({ panels: [legacy], events: [...resumedHistory] });
  existing.session.rpc.canvas.list = async () => assert.fail("A legacy panel must not be replaced or focused");
  await existing.startup.start();
  assert.equal(existing.startup.status, "panel-already-open");
  assert.deepEqual(existing.opened, []);

  for (const type of ["session.canvas.closed", "session.canvas.removed"]) {
    const dismissed = fixture({ events: [...resumedHistory, { type, data: legacy }] });
    await dismissed.startup.start();
    assert.equal(dismissed.startup.status, "dismissed");
    const reload = new Startup(dismissed.session, dismissed.preferences, dismissed.dependencies);
    await reload.start();
    assert.equal(reload.status, "dismissed");
    assert.deepEqual(dismissed.opened, []);
  }

  const missing = fixture({ events: [
    { type: "session.canvas.recorded", data: legacy }, ...resumedHistory,
  ] });
  await missing.startup.start();
  assert.equal(missing.startup.status, "opened");
  assert.equal(missing.opened.length, 1);
  assert.equal(missing.opened[0].instanceId, "github-notifications-startup");
});

test("the final live snapshot prevents refocusing a panel opened during provider discovery", async () => {
  const item = fixture();
  item.session.rpc.canvas.list = async () => {
    item.panels.push(notificationPanel);
    return { canvases: [notificationPanel] };
  };
  await item.startup.start();
  assert.equal(item.startup.status, "panel-already-open");
  assert.deepEqual(item.opened, []);
});

test("durable dismissal survives resume, provider reload and later manual reopening", async () => {
  for (const type of ["session.canvas.closed", "session.canvas.removed"]) {
    const events = [...resumedHistory, { type, data: notificationPanel }];
    const item = fixture({ events });
    await item.startup.start();
    assert.equal(item.startup.status, "dismissed");
    assert.deepEqual(item.opened, []);
    item.emit({ type: "session.canvas.recorded", data: notificationPanel });
    const reload = new Startup(item.session, item.preferences, item.dependencies);
    await reload.start();
    assert.equal(reload.status, "dismissed");
    assert.deepEqual(item.opened, []);
  }
});

test("other canvases and provider unavailability do not count as dismissal", async () => {
  for (const type of canvasEvents) {
    const item = fixture({ events: [
      { type, data: otherPanel },
      { type: "session.canvas.unavailable", data: notificationPanel },
    ] });
    await item.startup.start();
    assert.equal(item.startup.status, "opened");
  }
});

test("late renderer readiness and internal resumes still open once", async () => {
  const item = fixture({ renderer: false, events: [...resumedHistory] });
  await item.startup.start();
  assert.equal(item.startup.status, "waiting-for-renderer");
  item.emit({ type: "session.resume" });
  item.emit({ type: "session.canvas.removed", data: otherPanel });
  item.emit({ type: "session.canvas.unavailable", data: notificationPanel });
  item.session.capabilities.ui.canvases = true;
  item.emit({ type: "capabilities.changed" });
  item.emit({ type: "capabilities.changed" });
  await item.startup.pending;
  assert.equal(item.startup.status, "opened");
  assert.equal(item.opened.length, 1);
  assert.equal(item.handlers.size, 0);
});

test("manual opens, dismissal, new activity and shutdown cancel deferred opening", async () => {
  for (const retrying of [false, true]) {
    for (const type of [...canvasEvents, "user.message", "assistant.turn_start", "assistant.message", "session.shutdown"]) {
      const item = fixture({ renderer: retrying, failOpen: retrying });
      await item.startup.start();
      item.emit({ type, data: notificationPanel });
      const status = ["session.canvas.closed", "session.canvas.removed"].includes(type) ? "dismissed"
        : ["session.canvas.opened", "session.canvas.recorded"].includes(type) ? "panel-already-open"
          : type === "session.shutdown" ? "stopped" : "session-already-active";
      assert.equal(item.startup.status, status);
      assert.ok(item.timers.every(timer => timer.cancelled));
      item.session.capabilities.ui.canvases = true;
      item.emit({ type: "capabilities.changed" });
      await item.startup.attempt();
      assert.deepEqual(item.opened, []);
      assert.equal(item.handlers.size, 0);
    }
  }
});

test("disabling while waiting or retrying prevents a later automatic open", async () => {
  for (const retrying of [false, true]) {
    const item = fixture({ renderer: retrying, failOpen: retrying });
    await item.startup.start();
    item.preference.autoOpen = false;
    if (retrying) await item.retry();
    else {
      item.session.capabilities.ui.canvases = true;
      item.emit({ type: "capabilities.changed" });
      await item.startup.pending;
    }
    assert.equal(item.startup.status, "disabled");
    assert.deepEqual(item.opened, []);
  }
});

test("activity or dismissal during each asynchronous inspection prevents opening and releases the lock", async t => {
  for (const stage of ["lock", "history", "panels", "providers"]) {
    for (const type of ["user.message", "session.canvas.removed", "session.canvas.recorded"]) {
      await t.test(`${stage}: ${type}`, async () => {
        const item = fixture();
        let releases = 0;
        const release = async () => { releases++; };
        item.startup.lock = async () => release;
        const activate = result => async () => {
          item.emit({ type, data: notificationPanel });
          return result;
        };
        if (stage === "lock") item.startup.lock = activate(release);
        else if (stage === "history") item.session.getEvents = activate([]);
        else if (stage === "panels") item.session.rpc.canvas.listOpen = activate({ openCanvases: [] });
        else item.session.rpc.canvas.list = activate({ canvases: [notificationPanel] });
        await item.startup.start();
        assert.deepEqual(item.opened, []);
        assert.equal(releases, 1);
        assert.equal(item.timers.length, 0);
      });
    }
  }
});

test("dismissal during the opening RPC is not overwritten by its eventual success", async () => {
  const item = fixture();
  item.session.rpc.canvas.open = async () => item.emit({
    type: "session.canvas.removed", data: { ...notificationPanel, instanceId: STARTUP_INSTANCE },
  });
  await item.startup.start();
  assert.equal(item.startup.status, "dismissed");
  assert.equal(item.timers.length, 0);
});

test("auto-open explicitly prefers the project provider regardless of registration order", async () => {
  const project = { ...notificationPanel, extensionId: "project:github-notifications" };
  for (const canvases of [[notificationPanel, project], [project, notificationPanel], [project]]) {
    const item = fixture({ canvases: [otherPanel, ...canvases] });
    await item.startup.start();
    assert.equal(item.startup.status, "opened");
    assert.equal(item.opened[0].extensionId, project.extensionId);
  }
});

test("temporary provider failures retry after one and two seconds, then stop without permanent state", async () => {
  const item = fixture({ failOpen: true });
  let releases = 0;
  item.startup.lock = async () => async () => { releases++; };
  await item.startup.start();
  assert.equal(item.startup.status, "retrying");
  await item.startup.attempt();
  assert.equal(releases, 1, "Repeated calls must not bypass the retry delay");
  await item.retry();
  await item.retry();
  assert.equal(item.startup.status, "error");
  assert.deepEqual(item.timers.map(timer => timer.delay), [1_000, 2_000]);
  assert.equal(releases, 3);
  assert.equal(item.logs.length, 3);
  assert.ok(item.logs.every(([, options]) => options.level === "warning"));
  assert.equal(JSON.stringify(item.logs).includes("sensitive"), false);
  assert.equal(item.handlers.size, 0);
  assert.deepEqual(item.opened, []);

  item.session.rpc.canvas.open = async input => { item.opened.push(input); };
  const reload = new Startup(item.session, item.preferences, item.dependencies);
  await reload.start();
  assert.equal(reload.status, "opened", "A later attachment can retry an exhausted startup");
});

test("a retry is not lost when the warning RPC takes longer than its delay", async t => {
  const item = fixture({ failOpen: true });
  t.after(() => item.startup.close());
  let completeWarning;
  item.session.log = () => new Promise(resolve => { completeWarning = resolve; });
  const starting = item.startup.start();
  await new Promise(resolve => setImmediate(resolve));
  for (const timer of item.timers) {
    timer.fired = true;
    timer.callback();
  }
  completeWarning();
  await starting;
  item.session.rpc.canvas.open = async input => { item.opened.push(input); };
  await item.retry();
  assert.equal(item.startup.status, "opened");
  assert.equal(item.opened.length, 1);
});

test("cancellation during a slow warning prevents scheduling a retry afterward", async () => {
  for (const type of ["session.canvas.removed", "session.canvas.recorded", "user.message", "session.shutdown"]) {
    const item = fixture({ failOpen: true });
    let completeWarning;
    item.session.log = () => new Promise(resolve => { completeWarning = resolve; });
    const starting = item.startup.start();
    await new Promise(resolve => setImmediate(resolve));
    item.emit({ type, data: notificationPanel });
    const status = item.startup.status;
    assert.equal(item.startup.stopped, true);
    completeWarning();
    await starting;
    assert.equal(item.startup.status, status);
    assert.equal(item.startup.timer, undefined);
    assert.ok(item.timers.every(timer => timer.cancelled));
    assert.equal(item.handlers.size, 0);
    assert.deepEqual(item.opened, []);
  }
});

test("missing and ambiguous providers can recover during the bounded retry window", async () => {
  for (const canvases of [[], [notificationPanel, { ...notificationPanel, extensionId: "user:other-copy" }]]) {
    const item = fixture({ canvases });
    await item.startup.start();
    assert.equal(item.startup.status, "retrying");
    canvases.splice(0, canvases.length, notificationPanel);
    await item.retry();
    assert.equal(item.startup.status, "opened");
    assert.equal(item.opened.length, 1);
    assert.equal(JSON.stringify(item.logs).includes("user:other-copy"), false);
  }
});

test("a failed RPC that actually opened a panel is reconciled without reopening or focusing it", async () => {
  const item = fixture();
  let attempts = 0;
  item.session.rpc.canvas.open = async input => {
    attempts++;
    item.panels.push(input);
    throw new Error("Synthetic lost response");
  };
  await item.startup.start();
  await item.retry();
  assert.equal(item.startup.status, "panel-already-open");
  assert.equal(attempts, 1);
});

test("lock contention is bounded and does not produce warnings unless retries are exhausted", async () => {
  const item = fixture();
  item.startup.lock = async () => null;
  await item.startup.start();
  await item.retry();
  assert.deepEqual(item.logs, []);
  await item.retry();
  assert.equal(item.startup.status, "error");
  assert.equal(item.logs.length, 1);
  assert.deepEqual(item.opened, []);
});

test("same-session providers serialize opens and reconcile the shared runtime snapshot", async t => {
  const directory = await workspace(t);
  const item = fixture();
  item.session.workspacePath = directory;
  item.startup.lock = acquireStartupLock;
  const second = new Startup(item.session, item.preferences, { ...item.dependencies, lock: acquireStartupLock });
  await Promise.all([item.startup.start(), second.start()]);
  assert.equal(item.opened.length, 1);
  assert.deepEqual([item.startup.status, second.status].sort(), ["opened", "panel-already-open"]);
  assert.deepEqual(await fs.readdir(join(directory, "files")), []);
  assert.ok(item.timers.every(timer => timer.cancelled));
});

test("different sessions sharing a preference each open independently and keep dismissal local", async t => {
  const root = await workspace(t);
  const one = fixture();
  const two = fixture();
  for (const [index, item] of [one, two].entries()) {
    item.session.workspacePath = join(root, `session-${index}`);
    item.startup.lock = acquireStartupLock;
  }
  two.startup.preferences = one.preferences;
  await Promise.all([one.startup.start(), two.startup.start()]);
  assert.equal(one.opened.length, 1);
  assert.equal(two.opened.length, 1);
  one.panels.length = 0;
  one.emit({ type: "session.canvas.removed", data: one.opened[0] });
  two.panels.length = 0;
  const resumedOne = new Startup(one.session, one.preferences, { ...one.dependencies, lock: acquireStartupLock });
  const resumedTwo = new Startup(two.session, one.preferences, { ...two.dependencies, lock: acquireStartupLock });
  await Promise.all([resumedOne.start(), resumedTwo.start()]);
  assert.equal(resumedOne.status, "dismissed");
  assert.equal(resumedTwo.status, "opened");
  assert.equal(one.opened.length, 1);
  assert.equal(two.opened.length, 2);
});

test("obsolete checked markers are preserved but do not suppress an undismissed session", async t => {
  const directory = await workspace(t);
  await fs.mkdir(join(directory, "files"));
  const marker = join(directory, "files", "github-notifications-startup.json");
  const content = '{"checked":true}\n';
  await fs.writeFile(marker, content);
  const item = fixture({ events: [...resumedHistory] });
  item.session.workspacePath = directory;
  item.startup.lock = acquireStartupLock;
  await item.startup.start();
  assert.equal(item.startup.status, "opened");
  assert.equal(await fs.readFile(marker, "utf8"), content);
  assert.deepEqual(await fs.readdir(join(directory, "files")), ["github-notifications-startup.json"]);
});

test("startup locks reject missing workspaces, malformed locks and symlinks without replacing data", async t => {
  await assert.rejects(acquireStartupLock(undefined), /Session workspace unavailable/);
  const directory = await workspace(t);
  const files = join(directory, "files");
  const lock = join(files, ".github-notifications-startup.lock");
  await fs.mkdir(files);
  await fs.writeFile(lock, "do not replace");
  await assert.rejects(acquireStartupLock(directory));
  assert.equal(await fs.readFile(lock, "utf8"), "do not replace");
  await fs.unlink(lock);
  const target = join(directory, "target");
  await fs.mkdir(target);
  await fs.symlink(target, lock, "junction");
  await assert.rejects(acquireStartupLock(directory));
  assert.equal((await fs.lstat(lock)).isSymbolicLink(), true);
  assert.deepEqual(await fs.readdir(target), []);
  assert.deepEqual(await fs.readdir(files), [".github-notifications-startup.lock"]);
});

test("preference, history and cleanup failures are sanitized without leaking locks", async () => {
  const settings = fixture();
  settings.preferences.read = async () => { throw new Error("sensitive settings failure"); };
  await settings.startup.start();
  assert.equal(settings.startup.status, "error");
  assert.equal(settings.logs.length, 1);

  for (const stage of ["lock", "history", "release"]) {
    const item = fixture();
    let releases = 0;
    item.startup.lock = async () => {
      if (stage === "lock") throw new Error("sensitive lock failure");
      return async () => {
        releases++;
        if (stage === "release") throw new Error("sensitive cleanup failure");
      };
    };
    if (stage === "history") item.session.getEvents = async () => { throw new Error("sensitive history failure"); };
    await item.startup.start();
    assert.equal(item.startup.status, "retrying");
    assert.equal(releases, stage === "lock" ? 0 : 1);
    assert.equal(JSON.stringify(item.logs).includes("sensitive"), false);
    await item.startup.close();
    assert.ok(item.timers.every(timer => timer.cancelled));
  }
});

test("shutdown cancels timers and awaits in-flight lock cleanup without opening", async () => {
  const item = fixture();
  let complete;
  let releases = 0;
  item.startup.lock = () => new Promise(resolve => { complete = () => resolve(async () => { releases++; }); });
  const starting = item.startup.start();
  await new Promise(resolve => setImmediate(resolve));
  const closing = item.startup.close();
  complete();
  await Promise.all([starting, closing]);
  assert.equal(releases, 1);
  assert.equal(item.startup.status, "stopped");
  assert.deepEqual(item.opened, []);
  assert.equal(item.handlers.size, 0);
  await item.startup.start();
  assert.deepEqual(item.opened, []);
});

test("activity during the initial settings read is observed before any opening work", async () => {
  for (const type of ["user.message", "assistant.turn_start", "assistant.message",
    "session.canvas.removed", "session.canvas.recorded", "session.shutdown"]) {
    const item = fixture();
    let complete;
    let reads = 0;
    let locks = 0;
    item.preferences.read = () => ++reads === 1
      ? new Promise(resolve => { complete = resolve; })
      : Promise.resolve({ autoOpen: true });
    item.startup.lock = async () => { locks++; return async () => {}; };
    const starting = item.startup.start();
    const subscriptions = item.handlers.size;
    item.emit({ type, data: notificationPanel });
    complete({ autoOpen: true });
    await starting;
    assert.equal(subscriptions, 1, type);
    assert.equal(locks, 0, type);
    assert.deepEqual(item.opened, [], type);
    assert.equal(item.handlers.size, 0, type);
    assert.equal(item.timers.length, 0, type);
  }
});

test("shutdown during the initial settings read removes subscriptions and prevents opening", async () => {
  const item = fixture();
  let complete;
  item.preferences.read = () => new Promise(resolve => { complete = resolve; });
  const starting = item.startup.start();
  assert.equal(item.handlers.size, 1);
  await item.startup.close();
  complete({ autoOpen: true });
  await starting;
  assert.equal(item.handlers.size, 0);
  assert.deepEqual(item.opened, []);
  assert.equal(item.startup.status, "stopped");
});

test("production retry timers are unreferenced and shutdown clears them", async () => {
  const item = fixture({ failOpen: true });
  const startup = new Startup(item.session, item.preferences, { lock: item.dependencies.lock });
  await startup.start();
  assert.equal(startup.status, "retrying");
  assert.equal(startup.timer.hasRef(), false);
  await startup.close();
  assert.equal(startup.timer, undefined);
  assert.equal(item.handlers.size, 0);
});

test("an opening failure after dismissal is reported but never retried", async () => {
  const item = fixture();
  item.session.rpc.canvas.open = async () => {
    item.emit({ type: "session.canvas.removed", data: notificationPanel });
    throw new Error("Synthetic closed provider");
  };
  await item.startup.start();
  assert.equal(item.startup.status, "dismissed");
  assert.equal(item.timers.length, 0);
  assert.equal(item.logs.length, 1);
});
