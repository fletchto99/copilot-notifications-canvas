import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DesktopNotifications } from "../.github/extensions/github-notifications/desktop.mjs";
import { Preferences } from "../.github/extensions/github-notifications/settings.mjs";
import { GitHubClient, POLL_MS } from "../.github/extensions/github-notifications/github.mjs";
import { InboxError } from "../.github/extensions/github-notifications/model.mjs";
import { http, thread, next } from "./fixtures.mjs";

const epoch = Date.parse("2026-01-10T12:00:00Z");
const updated = (id, time) => thread(id, { updated_at: new Date(time).toISOString() });

async function fixture(t, { enabled = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "notifications-desktop-test-"));
  const preferences = new Preferences({ directory });
  if (enabled) await preferences.update({ desktopNotifications: true });
  let now = epoch;
  let rows = [thread()];
  let response;
  const calls = [];
  const deliveries = [];
  const logs = [];
  const instances = [];
  t.after(async () => {
    await Promise.all(instances.map(instance => instance.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, preferences, calls, deliveries, logs,
    advance(ms = POLL_MS) { now += ms; return now; },
    rows(value) { rows = value; },
    response(value) { response = value; },
    async state() { return JSON.parse(await readFile(join(directory, "desktop-state.json"), "utf8")); },
    make(overrides = {}) {
      const watcher = new DesktopNotifications({
        preferences, platform: "darwin", now: () => now,
        client: new GitHubClient({ now: () => now, run: async args => {
          calls.push(args);
          return response ? response(args) : http(rows);
        } }),
        notify: async options => { deliveries.push(options); },
        log: (...args) => logs.push(args),
        schedule: () => 0, cancel: () => {},
        ...overrides,
      });
      instances.push(watcher);
      watcher.add(`panel-${instances.length}`);
      return watcher;
    },
  };
}

test("desktop watching is opt-in and never invokes GitHub or the sender when disabled or unsupported", async t => {
  const f = await fixture(t, { enabled: false });
  const off = f.make();
  await off.check();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.directory), []);
  await f.preferences.update({ desktopNotifications: true });
  const unsupported = f.make({ platform: "freebsd" });
  await unsupported.check();
  assert.equal(unsupported.snapshot().supported, false);
  assert.match(unsupported.snapshot().message, /macOS/);
  assert.equal(f.calls.length, 0);
});

test("initial backlog is silent and small batches retain each thread's title and body", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  assert.equal(f.deliveries.length, 0);
  await watcher.check();
  assert.equal(f.calls.length, 1);
  const time = f.advance();
  f.rows([updated("2", time), updated("3", time - 1000), thread()]);
  await watcher.check();
  assert.equal(f.deliveries.length, 2);
  assert.deepEqual(Object.keys(f.deliveries[0]).sort(), ["body", "platform", "signal", "sound", "title"]);
  assert.equal(f.deliveries[0].sound, "default");
  assert.equal(f.deliveries[0].title, "example/widgets");
  assert.equal(f.deliveries[0].body, "Synthetic notification 2");
  assert.equal(f.deliveries[1].body, "Synthetic notification 3");
  f.advance();
  await watcher.check();
  assert.equal(f.deliveries.length, 2);
  await f.preferences.update({ desktopSound: "Ping" });
  f.rows([updated("1", f.advance())]);
  await watcher.check();
  assert.equal(f.deliveries.length, 3);
  assert.equal(f.deliveries[2].sound, "Ping");
  const state = await f.state();
  assert.equal(state.fingerprints.length, 1);
  assert.match(state.fingerprints[0], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(state), /Synthetic|example\/widgets|updatedAt|repository|title/);
  assert.equal((await stat(join(f.directory, "desktop-state.json"))).mode & 0o777, 0o600);
});

test("bursts group at exactly five new notifications from a repository", async t => {
  for (const count of [1, 4, 5, 6]) {
    const f = await fixture(t);
    const watcher = f.make();
    await watcher.check();
    const time = f.advance();
    const arrivals = Array.from({ length: count }, (_, index) => updated(String(index + 2), time));
    f.rows([...arrivals, thread()]);
    await watcher.check();
    assert.equal(f.deliveries.length, count < 5 ? count : 1, `count ${count}`);
    assert.ok(f.deliveries.every(alert => alert.title === "example/widgets"));
    if (count >= 5) assert.equal(f.deliveries[0].body, `${count} new notifications`);
    else assert.deepEqual(new Set(f.deliveries.map(alert => alert.body)),
      new Set(arrivals.map(item => item.subject.title)));
    f.advance();
    await watcher.check();
    assert.equal(f.deliveries.length, count < 5 ? count : 1, "unchanged activity stays silent");
  }
});

test("burst counts are per repository and exclude the existing inbox and read threads", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  const time = f.advance();
  let id = 2;
  const arrivals = [["example/widgets", 5], ["example/tools", 4], ["other/service", 1]]
    .flatMap(([repository, count]) => Array.from({ length: count }, () => thread(String(id++), {
      repository: { full_name: repository }, updated_at: new Date(time).toISOString(),
    })));
  f.rows([...arrivals, thread(), thread("99", {
    repository: { full_name: "example/tools" }, unread: false, updated_at: new Date(time).toISOString(),
  })]);
  await watcher.check();
  assert.equal(f.deliveries.length, 6);
  assert.deepEqual(f.deliveries.filter(alert => alert.title === "example/widgets").map(alert => alert.body), ["5 new notifications"]);
  assert.deepEqual(f.deliveries.filter(alert => alert.title === "example/tools").map(alert => alert.body).sort(),
    arrivals.filter(item => item.repository.full_name === "example/tools").map(item => item.subject.title).sort());
  assert.deepEqual(f.deliveries.filter(alert => alert.title === "other/service").map(alert => alert.body), ["Synthetic notification 11"]);
});

test("large initial backlogs are silent and a later small update does not summarize all unread items", async t => {
  const f = await fixture(t);
  const backlog = Array.from({ length: 8 }, (_, index) => updated(String(index + 1), epoch - 1000));
  f.rows(backlog);
  const watcher = f.make();
  await watcher.check();
  assert.equal(f.deliveries.length, 0);
  const time = f.advance();
  f.rows([...backlog, updated("1", time)]);
  await watcher.check();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].body, "Synthetic notification 1");
});

test("equal-timestamp arrivals are detected without replaying known IDs or older promoted rows", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  const time = f.advance();
  f.rows([updated("2", time)]);
  await watcher.check();
  f.advance();
  f.rows([updated("2", time), updated("3", time), updated("4", epoch - 1000)]);
  await watcher.check();
  assert.equal(f.deliveries.length, 2);
  f.advance();
  f.rows([updated("2", time), thread("5", { unread: false, updated_at: new Date(time + 1).toISOString() })]);
  await watcher.check();
  f.advance();
  f.rows([updated("3", time)]);
  await watcher.check();
  assert.equal(f.deliveries.length, 2);
});

test("new activity spanning pages produces one complete burst summary only after fetching succeeds", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  const time = f.advance();
  const arrivals = Array.from({ length: 60 }, (_, i) => updated(String(i + 2), time - i * 100));
  let fail = true;
  f.response(args => args.at(-1).includes("page=1") ? http(arrivals.slice(0, 50), { link: next }) :
    fail ? http({}, {}, 500) : http([...arrivals.slice(50), thread()]));
  await watcher.check();
  assert.equal(f.deliveries.length, 0);
  assert.equal((await f.state()).watermark, epoch);
  fail = false;
  f.advance();
  await watcher.check();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].title, "example/widgets");
  assert.equal(f.deliveries[0].body, "60 new notifications");
  f.advance();
  await watcher.check();
  assert.equal(f.deliveries.length, 1);
});

test("the backend timer runs without a renderer and is cancelled when its final panel closes", async t => {
  const f = await fixture(t);
  const timers = new Map();
  let nextTimer = 0;
  const watcher = f.make({
    schedule: (run, delay) => { timers.set(++nextTimer, { run, delay }); return nextTimer; },
    cancel: id => timers.delete(id),
  });
  const first = [...timers.values()][0];
  assert.equal(first.delay, 0);
  first.run();
  await watcher.pending;
  assert.equal(f.calls.length, 1);
  assert.equal([...timers.values()][0].delay, 5000);
  f.rows([updated("2", f.advance())]);
  [...timers.values()][0].run();
  await watcher.pending;
  assert.equal(f.deliveries.length, 1);
  await watcher.close();
  assert.equal(timers.size, 0);
});

test("copies share the poll deadline and checkpoint, including after one closes", async t => {
  const f = await fixture(t);
  const one = f.make();
  const two = f.make();
  await Promise.all([one.check(), two.check()]);
  assert.equal(f.calls.length, 1);
  await two.check();
  const time = f.advance();
  f.rows([updated("2", time)]);
  await Promise.all([one.check(), two.check()]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.deliveries.length, 1);
  await one.close();
  f.advance();
  await two.check();
  assert.equal(f.deliveries.length, 1);
  f.rows([updated("2", f.advance())]);
  await two.check();
  assert.equal(f.deliveries.length, 2);
});

test("closing one local panel keeps watching; closing the last stops and reopening baselines silently", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  watcher.add("second");
  await watcher.check();
  await watcher.remove("panel-1");
  f.rows([updated("2", f.advance())]);
  await watcher.check();
  assert.equal(f.deliveries.length, 1);
  await watcher.remove("second");
  f.rows([updated("3", f.advance())]);
  await watcher.check();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(await readdir(join(f.directory, "desktop-watchers")), []);
  watcher.add("reopened");
  await watcher.check();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.calls.length, 3);
});

test("disable and re-enable between watcher checks still resets the baseline", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  await f.preferences.update({ desktopNotifications: false });
  await f.preferences.update({ desktopNotifications: true });
  f.rows([updated("2", f.advance())]);
  await watcher.check();
  assert.equal(f.deliveries.length, 0);
  f.rows([updated("3", f.advance())]);
  await watcher.check();
  assert.equal(f.deliveries.length, 1);
});

test("longer polling intervals and rate limits are shared by every watcher", async t => {
  const f = await fixture(t);
  f.response(() => http([thread()], { "x-poll-interval": "300" }));
  const one = f.make();
  const two = f.make();
  await one.check();
  f.advance(299_999);
  await two.check();
  assert.equal(f.calls.length, 1);
  f.advance(1);
  f.response(() => http({}, { "retry-after": "600" }, 429));
  await two.check();
  assert.equal(f.calls.length, 2);
  assert.equal(two.snapshot().state, "error");
  f.advance(599_999);
  await one.check();
  assert.equal(f.calls.length, 2);
  assert.equal(one.snapshot().state, "error");
  f.advance(1);
  f.response(() => http([updated("2", epoch + 900_000)]));
  await one.check();
  assert.equal(f.calls.length, 3);
  assert.equal(f.deliveries.length, 1);
});

test("a failed sender is not retried, even after another copy takes over", async t => {
  const f = await fixture(t);
  let attempts = 0;
  const one = f.make({ notify: async () => {
    attempts++;
    throw new InboxError("desktop_delivery", "Synthetic delivery failure");
  } });
  const two = f.make();
  await one.check();
  await two.check();
  f.rows([updated("2", f.advance())]);
  await one.check();
  assert.equal(attempts, 1);
  assert.equal(one.snapshot().state, "error");
  assert.equal(f.logs.length, 1);
  await one.close();
  f.advance();
  await two.check();
  assert.equal(f.deliveries.length, 0);
  f.rows([updated("3", f.advance())]);
  await two.check();
  assert.equal(f.deliveries.length, 1);
});

test("closing or disabling during an in-flight fetch prevents delivery", async t => {
  for (const action of ["close", "disable"]) {
    const f = await fixture(t);
    const watcher = f.make();
    await watcher.check();
    const time = f.advance();
    let finish;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    f.response(() => new Promise(resolve => { finish = resolve; started(); }));
    const checking = watcher.check();
    await ready;
    let closing;
    if (action === "close") closing = watcher.close();
    else await f.preferences.update({ desktopNotifications: false });
    finish(http([updated("2", time)]));
    await checking;
    await closing;
    assert.equal(f.deliveries.length, 0, action);
    assert.equal(f.logs.length, 0, action);
  }
});

test("malformed state, symlinks and unknown locks fail closed without alerting or overwriting", async t => {
  for (const kind of ["invalid", "symlink", "lock"]) {
    const f = await fixture(t);
    const path = join(f.directory, "desktop-state.json");
    if (kind === "invalid") await writeFile(path, "invalid");
    if (kind === "symlink") await symlink(f.preferences.path, path);
    if (kind === "lock") await writeFile(join(f.directory, ".desktop.lock"), "unrelated");
    const watcher = f.make();
    await watcher.check();
    assert.equal(watcher.snapshot().state, "error");
    assert.equal(f.calls.length, 0);
    assert.equal(f.deliveries.length, 0);
    assert.equal(f.logs.length, 1);
    if (kind === "invalid") assert.equal(await readFile(path, "utf8"), "invalid");
    if (kind === "lock") assert.equal(await readFile(join(f.directory, ".desktop.lock"), "utf8"), "unrelated");
  }
});

async function childWatcher(t, directory) {
  const module = new URL("../.github/extensions/github-notifications/desktop.mjs", import.meta.url).href;
  const settings = new URL("../.github/extensions/github-notifications/settings.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DesktopNotifications } from ${JSON.stringify(module)};
    import { Preferences } from ${JSON.stringify(settings)};
    let now = ${epoch};
    let updated = ${epoch};
    let count = 1;
    let pause = false;
    let pauseDelivery = false;
    let finish;
    const watcher = new DesktopNotifications({
      preferences: new Preferences({ directory: process.argv[1] }),
      platform: "darwin", now: () => now, schedule: () => 0, cancel: () => {},
      client: { clear() {}, blockedUntil: 0, async page() {
        process.send({ type: "poll" });
        if (pause) await new Promise(resolve => { finish = resolve; });
        return {
          items: Array.from({ length: count }, (_, index) => ({
            id: String(index + 1), repository: "example/widgets", title: "Synthetic notification " + (index + 1),
            unread: true, updatedAt: new Date(updated).toISOString(),
          })),
          nextRefreshAt: now + ${POLL_MS},
        };
      } },
      notify: async ({ title, body }) => {
        process.send({ type: "alert", title, body });
        if (pauseDelivery) await new Promise(() => {});
      },
    });
    watcher.add("test");
    process.on("message", async message => {
      if (message.type === "finish") { finish(); return; }
      now = message.now ?? now;
      updated = message.updated ?? updated;
      count = message.count ?? count;
      pause = message.pause ?? false;
      pauseDelivery = message.pauseDelivery ?? false;
      await watcher.check();
      process.send({ type: "done", status: watcher.snapshot() });
    });

    process.send({ type: "ready" });
  `, directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const events = [];
  child.on("message", message => events.push(message));
  const waitFor = (type, after = 0) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Child timed out: ${stderr}`)), 10_000);
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.off("message", check);
      child.off("exit", exited);
      error ? reject(error) : resolve(value);
    };
    const check = () => {
      const event = events.slice(after).find(event => event.type === type);
      if (event) finish(null, event);
    };
    const exited = () => finish(new Error(`Child exited: ${stderr}`));
    child.on("message", check);
    child.on("exit", exited);
    check();
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  };
  t.after(stop);
  await waitFor("ready");
  return {
    events, waitFor, stop,
    start(message = {}) { child.send({ type: "check", ...message }); },
    finish() { child.send({ type: "finish" }); },
    async check(message = {}) {
      const after = events.length;
      child.send({ type: "check", ...message });
      return waitFor("done", after);
    },
  };
}

test("separate OS processes send a burst summary once and recover a dead poller's lock", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  // Stop children before fixture cleanup removes their shared state.
  await t.test("cross-process coordination", async t => {
    const one = await childWatcher(t, f.directory);
    const two = await childWatcher(t, f.directory);
    await one.check();
    await two.check();
    const next = epoch + POLL_MS;
    await Promise.all([one.check({ now: next, updated: next, count: 5 }), two.check({ now: next, updated: next, count: 5 })]);
    assert.equal([...one.events, ...two.events].filter(event => event.type === "alert").length, 1);
    assert.deepEqual([...one.events, ...two.events].find(event => event.type === "alert"),
      { type: "alert", title: "example/widgets", body: "5 new notifications" });
    assert.equal([...one.events, ...two.events].filter(event => event.type === "poll").length, 2);
    const after = one.events.length;
    one.start({ now: next + POLL_MS, updated: next + POLL_MS, pause: true });
    await one.waitFor("poll", after);
    await two.check({ now: next + POLL_MS, updated: next + POLL_MS });
    await one.stop();
    await two.check({ now: next + 2 * POLL_MS, updated: next + POLL_MS });
    assert.equal([...one.events, ...two.events].filter(event => event.type === "alert").length, 2);
    assert.equal((await f.state()).error, null);
  });
});

test("a crash after claiming and sending activity cannot replay it in another process", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await t.test("post-delivery crash", async t => {
    const one = await childWatcher(t, f.directory);
    const two = await childWatcher(t, f.directory);
    await one.check();
    await two.check();
    const time = epoch + POLL_MS;
    one.start({ now: time, updated: time, pauseDelivery: true });
    await one.waitFor("alert");
    await one.stop();
    await two.check({ now: time + POLL_MS, updated: time });
    assert.equal(two.events.filter(event => event.type === "alert").length, 0);
    await two.check({ now: time + 2 * POLL_MS, updated: time + 2 * POLL_MS });
    assert.equal(two.events.filter(event => event.type === "alert").length, 1);
  });
});
