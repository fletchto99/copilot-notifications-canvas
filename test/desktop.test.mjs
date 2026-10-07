import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DesktopNotifications } from "../src/desktop.mjs";
import { Preferences } from "../src/settings.mjs";
import { GitHubClient, POLL_MS } from "../src/github.mjs";
import { InboxError } from "../src/model.mjs";
import { acquireLock } from "../src/lock.mjs";
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
  assert.equal(f.deliveries[0].body, "#42 Synthetic notification 2");
  assert.equal(f.deliveries[1].body, "#42 Synthetic notification 3");
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

test("individual desktop alerts include issue and PR numbers but not unrelated IDs on every platform", async t => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const f = await fixture(t);
    const watcher = f.make({ platform });
    await watcher.check();
    const updated_at = new Date(f.advance()).toISOString();
    f.rows([
      thread("101", { updated_at, subject: {
        type: "Issue", title: "Fix login", url: "https://api.github.com/repos/example/widgets/issues/7",
      } }),
      thread("102", { updated_at, subject: {
        type: "PullRequest", title: "Update tests", url: "https://api.github.com/repos/example/widgets/pulls/8",
      } }),
      thread("103", { updated_at, subject: { type: "Issue", title: "Missing link", url: null } }),
      thread("104", { updated_at, subject: {
        type: "Release", title: "New release", url: "https://api.github.com/repos/example/widgets/releases/9",
      } }),
    ]);
    await watcher.check();
    assert.deepEqual(f.deliveries.map(({ title, body }) => ({ title, body })), [
      { title: "example/widgets", body: "#7 Fix login" },
      { title: "example/widgets", body: "#8 Update tests" },
      { title: "example/widgets", body: "Missing link" },
      { title: "example/widgets", body: "New release" },
    ]);
    assert.ok(f.deliveries.every(alert => alert.platform === platform));
  }
});

test("a delayed initial response cannot hide activity that arrives before local fetch completion", async t => {
  const f = await fixture(t);
  let first = true;
  let rows = [updated("1", epoch - 60_000)];
  f.response(() => {
    if (first) { first = false; f.advance(2000); }
    return http(rows, { date: new Date(epoch).toUTCString() });
  });
  const watcher = f.make();
  await watcher.check();
  assert.equal((await f.state()).watermark, epoch - 60_000);
  assert.equal(f.deliveries.length, 0);
  rows = [updated("2", epoch + 1000), ...rows];
  f.advance();
  await watcher.check();
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
});

test("initial baselines preserve same-second arrivals even when the local clock is ahead", async t => {
  for (const skew of [500, 3_600_000]) {
    const f = await fixture(t);
    f.advance(skew);
    const watcher = f.make();
    await watcher.check();
    assert.equal((await f.state()).watermark, epoch);
    f.rows([thread(), thread("2")]);
    f.advance();
    await watcher.check();
    assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
  }
});

test("an empty initial inbox uses server time and does not skip same-second or delayed arrivals", async t => {
  for (const delta of [0, 1000]) {
    const f = await fixture(t);
    f.advance(3_600_000);
    let rows = [];
    f.response(() => http(rows, { date: new Date(epoch).toUTCString() }));
    const watcher = f.make();
    await watcher.check();
    assert.equal((await f.state()).watermark, epoch);
    rows = [updated("2", epoch + delta), updated("1", epoch - 1000)];
    f.advance();
    await watcher.check();
    assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
  }
});

test("an empty inbox without a valid API timestamp reports an error rather than guessing a local baseline", async t => {
  for (const headers of [{}, { date: "invalid" }]) {
    const f = await fixture(t);
    f.response(() => http([], headers));
    const watcher = f.make();
    await watcher.check();
    assert.equal(watcher.snapshot().state, "error");
    assert.match(watcher.snapshot().message, /snapshot timestamp/);
    assert.equal((await f.state()).watermark, null);
    assert.equal(f.deliveries.length, 0);
    await watcher.check();
    assert.equal(watcher.snapshot().state, "error");
    assert.equal(f.calls.length, 1);
    f.response(() => http([], { date: new Date(epoch).toUTCString() }));
    f.advance();
    await watcher.check();
    assert.equal(watcher.snapshot().state, "watching");
    assert.equal((await f.state()).watermark, epoch);
  }
});

test("initial pagination records every boundary fingerprint before allowing same-second arrivals", async t => {
  const f = await fixture(t);
  let rows = Array.from({ length: 60 }, (_, index) => updated(String(index + 1), epoch));
  f.response(args => args.at(-1).includes("page=1") ? http(rows.slice(0, 50), { link: next }) :
    http([...rows.slice(50), updated("99", epoch - 1000)]));
  const watcher = f.make();
  await watcher.check();
  assert.equal(f.calls.length, 2);
  assert.equal((await f.state()).fingerprints.length, 60);
  assert.equal(f.deliveries.length, 0);
  rows = [updated("61", epoch), ...rows.slice(40)];
  f.advance();
  await watcher.check();
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 61"]);
});

test("a failed initial boundary page does not commit a partial baseline", async t => {
  const f = await fixture(t);
  let fail = true;
  const rows = Array.from({ length: 50 }, (_, index) => updated(String(index + 1), epoch));
  f.response(args => args.at(-1).includes("page=1") ? http(rows, { link: next }) :
    fail ? http({}, {}, 500) : http([updated("51", epoch)]));
  const watcher = f.make();
  await watcher.check();
  assert.equal((await f.state()).watermark, null);
  assert.deepEqual((await f.state()).fingerprints, []);
  fail = false;
  f.advance();
  await watcher.check();
  assert.equal(f.deliveries.length, 0);
  assert.equal((await f.state()).fingerprints.length, 51);
});

test("activity seen on a later initial page does not advance the first snapshot's cutoff", async t => {
  const f = await fixture(t);
  const baseline = Array.from({ length: 50 }, (_, index) => updated(String(index + 1), epoch));
  let later = false;
  f.response(args => args.at(-1).includes("page=1") ?
    http(later ? [updated("51", epoch + 2000), updated("52", epoch + 1000), ...baseline] : baseline, { link: next }) :
    http([updated("51", epoch + 2000), updated("99", epoch - 1000)]));
  const watcher = f.make();
  await watcher.check();
  assert.equal((await f.state()).watermark, epoch);
  assert.equal(f.deliveries.length, 0);
  later = true;
  f.advance();
  await watcher.check();
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 51", "#42 Synthetic notification 52"]);
});

test("unsupported checkpoint versions and missing current fields fail closed without migration", async t => {
  for (const schema of [{ version: 1 }, { version: 1, cohort: null }, { version: 3, cohort: null }, { version: 2 }]) {
    const f = await fixture(t);
    const path = join(f.directory, "desktop-state.json");
    const content = JSON.stringify({
      ...schema, watchers: [], generation: null, watermark: epoch + 3_600_000,
      fingerprints: [], nextPollAt: 0, error: null,
    });
    await writeFile(path, content);
    const watcher = f.make();
    await watcher.check();
    assert.equal(watcher.snapshot().state, "error");
    assert.match(watcher.snapshot().message, /Desktop notification coordination failed/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.deliveries, []);
    assert.equal(f.logs.length, 1);
    assert.equal(f.logs[0][1].level, "error");
    assert.equal(await readFile(path, "utf8"), content);
  }
});

test("a missing checkpoint creates a current silent baseline after explicit offline cleanup", async t => {
  const f = await fixture(t);
  const path = join(f.directory, "desktop-state.json");
  const content = JSON.stringify({
    version: 1, watchers: [], generation: null, watermark: epoch + 3_600_000,
    fingerprints: [], nextPollAt: 0, error: null,
  });
  await writeFile(path, content);
  const backup = join(f.directory, "desktop-state.backup.json");
  await fs.rename(path, backup);
  const watcher = f.make();
  await watcher.check();
  assert.equal(watcher.snapshot().state, "watching");
  assert.equal((await f.state()).version, 2);
  assert.equal((await f.state()).watermark, epoch);
  assert.equal(f.deliveries.length, 0);
  assert.equal(await readFile(backup, "utf8"), content);
  f.rows([updated("2", epoch + 1000), thread()]);
  f.advance();
  await watcher.check();
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
});

test("invalid stored sound booleans stop watching without polling, delivery, or checkpoint writes", async t => {
  for (const desktopSound of [true, false]) {
    const f = await fixture(t);
    const settings = JSON.stringify({ ...await f.preferences.document(), desktopSound });
    await writeFile(f.preferences.path, settings);
    const watcher = f.make();
    await watcher.check();
    assert.equal(watcher.snapshot().state, "error");
    assert.match(watcher.snapshot().message, /desktopSound must be a supported sound name/);
    assert.equal(f.logs.length, 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.deliveries, []);
    assert.equal(await readFile(f.preferences.path, "utf8"), settings);
    await assert.rejects(readFile(join(f.directory, "desktop-state.json")), { code: "ENOENT" });
  }
});

test("a sound saved on another platform blocks watching until an explicit supported choice is saved", async t => {
  const f = await fixture(t);
  await f.preferences.update({ desktopSound: "Mail" });
  const watcher = f.make();
  await watcher.check();
  assert.equal(watcher.snapshot().state, "error");
  assert.match(watcher.snapshot().message, /sound supported by this operating system/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.deliveries, []);
  assert.deepEqual(await readdir(f.directory), ["settings.json"]);
  assert.equal((await f.preferences.read()).desktopSound, "Mail");
  watcher.wake(await f.preferences.update({ desktopSound: "default" }));
  await watcher.check();
  assert.equal(watcher.snapshot().state, "watching");
  assert.deepEqual(f.deliveries, []);
  f.rows([updated("2", f.advance())]);
  await watcher.check();
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
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
      new Set(arrivals.map(item => `#42 ${item.subject.title}`)));
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
  assert.equal(f.deliveries[0].body, "#42 Synthetic notification 1");
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
  assert.equal(one.cohort, two.cohort);
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

test("watchers joining during delivery retain continuity when the original closes", async t => {
  for (const chainedHandoff of [false, true]) {
    const f = await fixture(t);
    let entered;
    let finish;
    const ready = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { finish = resolve; });
    const one = f.make({ notify: async () => { entered(); await waiting; } });
    await one.check();
    const cohort = one.cohort;
    const time = f.advance();
    f.rows([updated("2", time), thread()]);
    const delivering = one.check();
    try {
      await ready;
      const two = f.make();
      await two.check();
      assert.equal(two.snapshot().state, "shared");
      assert.equal(two.cohort, cohort);
      assert.equal((await f.state()).watchers.includes(two.owner), false);
      let survivor = two;
      if (chainedHandoff) {
        survivor = f.make();
        await survivor.check();
        assert.equal(survivor.cohort, cohort);
        await two.close();
      }
      const closing = one.close();
      finish();
      await delivering;
      await closing;
      f.rows([updated("3", f.advance()), updated("2", time), thread()]);
      await survivor.check();
      assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 3"]);
      assert.equal((await f.state()).cohort, cohort);
    } finally {
      finish();
      await delivering;
    }
  }
});

test("a genuine gap creates a new cohort without replaying previously claimed activity", async t => {
  const f = await fixture(t);
  let attempts = 0;
  const one = f.make({ notify: async () => {
    attempts++;
    throw new InboxError("desktop_delivery", "Synthetic delivery failure");
  } });
  await one.check();
  const cohort = one.cohort;
  const time = f.advance();
  f.rows([updated("2", time), thread()]);
  await one.check();
  assert.equal(attempts, 1);
  await one.close();
  f.rows([thread()]);
  f.advance();
  const two = f.make();
  await two.check();
  assert.notEqual(two.cohort, cohort);
  assert.equal((await f.state()).watermark, time);
  f.rows([updated("2", time), thread()]);
  f.advance();
  await two.check();
  assert.equal(f.deliveries.length, 0);
  f.rows([updated("3", f.advance()), updated("2", time), thread()]);
  await two.check();
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 3"]);
});

test("closing cannot unregister a panel reopened while its registration lock is busy", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  const cohort = watcher.cohort;
  const release = await acquireLock(join(f.directory, ".desktop-watchers.lock"));
  assert.ok(release);
  const closing = watcher.remove("panel-1");
  try {
    await new Promise(resolve => setImmediate(resolve));
    watcher.add("reopened");
  } finally {
    await release();
  }
  await closing;
  assert.equal(watcher.registered, true);
  assert.equal(watcher.cohort, cohort);
  f.rows([updated("2", f.advance()), thread()]);
  await watcher.check();
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
});

test("reopening during marker removal preserves registration, its cohort and subsequent alerts", async t => {
  for (const removedBeforeReopen of [false, true]) {
    const f = await fixture(t);
    const watcher = f.make();
    await watcher.check();
    const cohort = watcher.cohort;
    const marker = watcher.markerPath;
    const unlink = fs.unlink;
    let entered;
    let finish;
    let paused = false;
    const ready = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { finish = resolve; });
    fs.unlink = async path => {
      if (path === marker && !paused) {
        paused = true;
        if (removedBeforeReopen) await unlink(path);
        entered();
        await waiting;
        if (removedBeforeReopen) return;
      }
      return unlink(path);
    };
    syncBuiltinESMExports();
    const closing = watcher.remove("panel-1");
    try {
      await ready;
      watcher.add("reopened");
      await watcher.check();
      finish();
      await closing;
      assert.equal(watcher.registered, true);
      assert.equal(watcher.cohort, cohort);
      assert.equal(JSON.parse(await readFile(marker, "utf8")).cohort, cohort);
      f.rows([updated("2", f.advance()), thread()]);
      await watcher.check();
      assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
      assert.equal((await f.state()).cohort, cohort);
      await watcher.close();
      assert.equal(watcher.registered, false);
      assert.deepEqual(await readdir(watcher.watchersPath), []);
    } finally {
      finish();
      await closing;
      fs.unlink = unlink;
      syncBuiltinESMExports();
    }
  }
});

test("closing again during registration restoration leaves no live marker behind", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  const marker = watcher.markerPath;
  const unlink = fs.unlink;
  const rename = fs.rename;
  let removed;
  let finishRemoval;
  let restoring;
  let finishRestoration;
  let pausedRemoval = false;
  let pausedRestoration = false;
  const removalStarted = new Promise(resolve => { removed = resolve; });
  const removalWait = new Promise(resolve => { finishRemoval = resolve; });
  const restorationStarted = new Promise(resolve => { restoring = resolve; });
  const restorationWait = new Promise(resolve => { finishRestoration = resolve; });
  fs.unlink = async path => {
    const result = await unlink(path);
    if (path === marker && !pausedRemoval) {
      pausedRemoval = true;
      removed();
      await removalWait;
    }
    return result;
  };
  fs.rename = async (from, to) => {
    const result = await rename(from, to);
    if (to === marker && !pausedRestoration) {
      pausedRestoration = true;
      restoring();
      await restorationWait;
    }
    return result;
  };
  syncBuiltinESMExports();
  const closing = watcher.remove("panel-1");
  let closingAgain;
  try {
    await removalStarted;
    watcher.add("reopened");
    finishRemoval();
    await restorationStarted;
    closingAgain = watcher.remove("reopened");
    finishRestoration();
    await Promise.all([closing, closingAgain]);
    assert.equal(watcher.panels.size, 0);
    assert.equal(watcher.registered, false);
    assert.equal(watcher.cohort, null);
    assert.deepEqual(await readdir(watcher.watchersPath), []);
    assert.deepEqual(f.logs, []);
  } finally {
    finishRemoval();
    finishRestoration();
    await Promise.all([closing, closingAgain]);
    fs.unlink = unlink;
    fs.rename = rename;
    syncBuiltinESMExports();
  }
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

test("failed checkpoint writes preserve the last published state and prevent native delivery", async t => {
  for (const checkpoint of ["poll reservation", "activity claim"]) {
    for (const operation of ["writeFile", "sync", "rename"]) {
      await t.test(`${checkpoint}: ${operation}`, async t => {
        const f = await fixture(t);
        const watcher = f.make();
        await watcher.check();
        const baseline = await f.state();
        const entries = (await readdir(f.directory)).sort();
        const time = f.advance();
        f.rows([updated("2", time), thread()]);
        const targetWatermark = checkpoint === "activity claim" ? time : baseline.watermark;
        const targets = new Set();
        const handles = [];
        let failures = 0;
        let lastPublished;
        const fail = async () => {
          failures++;
          lastPublished ??= await readFile(watcher.statePath, "utf8");
          throw Object.assign(new Error("Synthetic private disk failure"), { code: "ENOSPC" });
        };
        const open = fs.open;
        const rename = fs.rename;
        t.mock.method(fs, "open", async (path, flags, ...args) => {
          const file = await open(path, flags, ...args);
          if (flags === "wx" && path.startsWith(join(f.directory, ".desktop-"))) {
            handles.push(file);
            const write = file.writeFile.bind(file);
            const sync = file.sync.bind(file);
            t.mock.method(file, "writeFile", async content => {
              if (JSON.parse(content).watermark === targetWatermark) targets.add(path);
              if (targets.has(path) && operation === "writeFile") {
                await write(content.slice(0, 10));
                return fail();
              }
              return write(content);
            });
            t.mock.method(file, "sync", () => targets.has(path) && operation === "sync" ? fail() : sync());
          }
          return file;
        });
        t.mock.method(fs, "rename", (from, to) =>
          targets.has(from) && to === watcher.statePath && operation === "rename" ? fail() : rename(from, to));
        syncBuiltinESMExports();
        try {
          await watcher.check();
          assert.ok(failures > 0, "The selected checkpoint operation must fail");
          assert.equal(watcher.snapshot().state, "error");
          assert.equal(f.calls.length, checkpoint === "activity claim" ? 2 : 1);
          assert.deepEqual(f.deliveries, []);
          assert.equal(await readFile(watcher.statePath, "utf8"), lastPublished);
          assert.equal((await f.state()).watermark, baseline.watermark);
          assert.deepEqual((await f.state()).fingerprints, baseline.fingerprints);
          assert.deepEqual((await readdir(f.directory)).sort(), entries);
          assert.ok(handles.length > 0);
          assert.ok(handles.every(file => file.fd === -1), "Temporary checkpoint handles must be closed");
          assert.equal(f.logs.length, 1);
          assert.doesNotMatch(JSON.stringify(f.logs), /Synthetic private disk failure|Synthetic notification|example\/widgets/);
        } finally {
          t.mock.restoreAll();
          syncBuiltinESMExports();
        }
        f.advance();
        await watcher.check();
        assert.equal(watcher.snapshot().state, "watching");
        assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
        assert.equal((await f.state()).watermark, time);
        f.advance();
        await f.make().check();
        assert.equal(f.deliveries.length, 1, "Another watcher must not replay the recovered activity");
      });
    }
  }
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

test("saving disabled preferences aborts an active poll and re-enabling establishes a silent baseline", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  const time = f.advance();
  let started;
  let finish;
  const ready = new Promise(resolve => { started = resolve; });
  f.response(() => {
    started();
    return new Promise(resolve => { finish = () => resolve(http([updated("2", time)])); });
  });
  const pending = watcher.check();
  try {
    await ready;
    assert.equal(watcher.controller.signal.aborted, false);
    watcher.wake(await f.preferences.update({ desktopNotifications: false }));
    assert.equal(watcher.controller.signal.aborted, true);
    assert.equal(watcher.snapshot().state, "off");
  } finally {
    finish();
    await pending;
  }
  await watcher.check();
  assert.equal(watcher.registered, false);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.deliveries, []);
  assert.deepEqual(f.logs, []);
  f.response(undefined);
  f.rows([updated("2", f.advance())]);
  watcher.wake(await f.preferences.update({ desktopNotifications: true }));
  assert.equal(watcher.snapshot().state, "starting");
  await watcher.check();
  assert.equal(watcher.snapshot().state, "watching");
  assert.deepEqual(f.deliveries, []);
  f.rows([updated("3", f.advance())]);
  await watcher.check();
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 3"]);
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

test("invalid watcher metadata fails closed without overwriting the marker or fetching notifications", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await mkdir(watcher.watchersPath);
  await writeFile(watcher.markerPath, '{"cohort":"invalid"}');
  await watcher.check();
  assert.equal(watcher.snapshot().state, "error");
  assert.equal(f.calls.length, 0);
  assert.equal(f.deliveries.length, 0);
  assert.equal(await readFile(watcher.markerPath, "utf8"), '{"cohort":"invalid"}');
});

async function childWatcher(t, directory) {
  const module = new URL("../src/desktop.mjs", import.meta.url).href;
  const settings = new URL("../src/settings.mjs", import.meta.url).href;
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

test("a separate process joining during delivery inherits continuity even if the sender crashes", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await t.test("late joining process", async t => {
    const one = await childWatcher(t, f.directory);
    await one.check();
    const time = epoch + POLL_MS;
    one.start({ now: time, updated: time, pauseDelivery: true });
    await one.waitFor("alert");
    const two = await childWatcher(t, f.directory);
    const joined = await two.check({ now: time, updated: time });
    assert.equal(joined.status.state, "shared");
    await one.stop();
    await two.check({ now: time + POLL_MS, updated: time + POLL_MS });
    assert.equal(two.events.filter(event => event.type === "alert").length, 1);
    await two.check({ now: time + 2 * POLL_MS, updated: time + POLL_MS });
    assert.equal(two.events.filter(event => event.type === "alert").length, 1);
  });
});
