import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DesktopNotifications } from "../src/provider/desktop.mjs";
import { Preferences } from "../src/provider/settings.mjs";
import { firstPage, GitHubClient, POLL_MS, RETRY_MS } from "../src/provider/github.mjs";
import { Inbox } from "../src/provider/inbox.mjs";
import { InboxError } from "../src/shared/model.mjs";
import { acquireLock } from "../src/provider/lock.mjs";
import { http, thread, next, workflowRun, workflowJob } from "./fixtures.mjs";

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
    advance(ms = RETRY_MS) { now += ms; return now; },
    rows(value) { rows = value; },
    response(value) { response = value; },
    async state() { return JSON.parse(await readFile(join(directory, "desktop-state.json"), "utf8")); },
    make(overrides = {}) {
      const watcher = new DesktopNotifications({
        preferences, platform: "darwin", now: () => now,
        findNotifier: async () => null,
        client: new GitHubClient({ now: () => now, sleep: async delay => { now += delay; }, run: async args => {
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

function watcherTimers() {
  const timers = new Map();
  let id = 0;
  return {
    timers,
    schedule(run, delay) { timers.set(++id, { run, delay }); return id; },
    cancel(timer) { timers.delete(timer); },
    async fire(watcher, delay = 5000) {
      assert.equal(timers.size, 1);
      const [timerId, timer] = [...timers][0];
      assert.equal(timer.delay, delay);
      timers.delete(timerId);
      timer.run();
      await (watcher.foregroundPending ?? watcher.pending);
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

test("foreground preparation ignores desktop checkpoints when alerts are disabled or unsupported", async t => {
  for (const enabled of [false, true]) {
    for (const checkpoint of ["malformed", "unsupported", "blocked"]) {
      const f = await fixture(t, { enabled });
      const watcher = f.make({ platform: enabled ? "freebsd" : "win32" });
      const content = checkpoint === "malformed" ? "not JSON" : JSON.stringify({
        version: checkpoint === "unsupported" ? 1 : 2, watchers: [], cohort: null, generation: null,
        watermark: null, fingerprints: [], nextPollAt: epoch + 600_000, blockedUntil: epoch + 600_000, error: null,
      });
      await writeFile(watcher.statePath, content);
      for (let count = 0; count < 2; count++) {
        await watcher.prepareForeground();
        await watcher.check();
      }
      assert.equal(watcher.snapshot().state, "off");
      assert.equal(watcher.client.blockedUntil, 0);
      assert.deepEqual(f.logs, []);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.deliveries, []);
      await watcher.client.page(firstPage(), undefined, { force: true });
      assert.equal(f.calls.length, 1, "the centralized request hook must leave disabled/unsupported clients alone");
      assert.deepEqual(f.logs, []);
      assert.equal(await readFile(watcher.statePath, "utf8"), content);
    }
  }
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
  assert.deepEqual(Object.keys(f.deliveries[0]).sort(), ["body", "platform", "signal", "sound", "terminalNotifier", "title", "url"]);
  assert.equal(f.deliveries[0].sound, "default");
  assert.equal(f.deliveries[0].title, "example/widgets");
  assert.equal(f.deliveries[0].body, "#42 Synthetic notification 2");
  assert.equal(f.deliveries[1].body, "#42 Synthetic notification 3");
  assert.equal(f.deliveries[0].url, "https://github.com/example/widgets/pull/42");
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

test("background desktop checks run at one minute, never earlier", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  assert.equal((await f.state()).nextPollAt, epoch + 60_000);
  for (let checks = 0; checks < 3; checks++) {
    f.rows([updated("2", f.advance(15_000)), thread()]);
    await watcher.check();
    assert.equal(f.calls.length, 1);
    assert.equal(f.deliveries.length, 0);
  }
  f.advance(14_999);
  await watcher.check();
  assert.equal(f.calls.length, 1);
  f.advance(1);
  await watcher.check();
  assert.equal(f.calls.length, 2);
  assert.equal(f.deliveries.length, 1);
});

test("unread-mode foreground refreshes share results with alerts and retain the polling cadence", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  const inbox = new Inbox(watcher.client, { mode: "unread" });
  t.after(() => inbox.close());
  await watcher.prepareForeground();
  await inbox.refresh();
  await watcher.sync();
  assert.equal(f.calls.length, 1);
  assert.equal(f.deliveries.length, 0);
  const time = f.advance(60_000);
  f.rows([updated("2", time), thread()]);
  await inbox.refresh();
  await watcher.sync();
  assert.equal(f.calls.length, 2, "desktop delivery reuses the foreground response");
  assert.equal(inbox.snapshot().groups[0].items[0].id, "2");
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
  assert.equal((await f.state()).nextPollAt, time + 60_000);
  assert.equal((await f.state()).polling, false);
  f.rows([updated("3", f.advance(30_000)), thread()]);
  await watcher.check();
  assert.equal(f.calls.length, 2);
  f.advance(29_999);
  await watcher.check();
  assert.equal(f.calls.length, 2);
  f.advance(1);
  await watcher.check();
  assert.equal(f.calls.length, 3);
  assert.equal(f.deliveries.length, 2);
});

test("inbox matching uses a separate cache while disabling it shares the unread desktop feed", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  const inbox = new Inbox(watcher.client);
  const unmatched = new Inbox(watcher.client);
  unmatched.setMatchGitHubInbox(false);
  t.after(() => { inbox.close(); unmatched.close(); });
  let unread = [thread("1")];
  f.response(args => {
    const query = new URL(args.at(-1), "https://api.github.com").searchParams;
    return http(query.get("all") === "false" ? unread :
      [...unread, thread("9", { unread: false, updated_at: "2026-02-01T12:00:00Z" })]);
  });
  await watcher.prepareForeground();
  await inbox.refresh();
  await unmatched.refresh();
  await watcher.sync();
  assert.equal(f.calls.length, 2);
  assert.equal(unmatched.summary().loaded, 1);
  assert.equal((await f.state()).watermark, epoch);
  assert.deepEqual(f.deliveries, []);
  const time = f.advance(POLL_MS);
  unread = [updated("2", time), ...unread];
  await inbox.refresh();
  await watcher.check();
  assert.deepEqual(f.deliveries.map(message => message.body), ["#42 Synthetic notification 2"]);
  assert.match(f.calls.at(-1).at(-1), /all=false/);
  assert.equal(inbox.summary().loaded, 3);
  assert.equal(inbox.summary().unread, 2);
});

test("an immediate unread-mode foreground return feeds activity to alerts without waiting", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  const inbox = new Inbox(watcher.client, { mode: "unread" });
  t.after(() => inbox.close());
  await watcher.prepareForeground();
  await inbox.refresh();
  await watcher.sync();
  f.rows([updated("2", f.advance(1000)), thread()]);
  await inbox.refresh({ force: true });
  await watcher.sync();
  assert.equal(f.calls.length, 2);
  assert.equal(f.deliveries.length, 1);
  await watcher.sync();
  assert.equal(f.calls.length, 2);
  assert.equal(f.deliveries.length, 1);
});

test("opening another panel with cached results does not postpone the background poll", async t => {
  for (const interval of [60, 300]) {
    const f = await fixture(t);
    const watcher = f.make();
    const first = new Inbox(watcher.client, { mode: "unread" });
    const second = new Inbox(watcher.client, { mode: "unread" });
    t.after(() => { first.close(); second.close(); });
    f.response(() => http([thread()], { "x-poll-interval": String(interval) }));
    await watcher.prepareForeground();
    await first.refresh();
    await watcher.sync();
    const deadline = epoch + interval * 1000;
    assert.equal((await f.state()).nextPollAt, deadline);

    f.advance(interval * 1000 - 30_000);
    watcher.add("second-panel");
    await watcher.prepareForeground();
    await second.refresh();
    await watcher.sync();
    assert.equal(f.calls.length, 1, "the second panel and watcher reuse the original response");
    assert.equal((await f.state()).nextPollAt, deadline);
    assert.equal((await f.state()).polling, false);
    assert.deepEqual(f.deliveries, []);

    f.response(undefined);
    f.rows([updated("2", f.advance(29_999)), thread()]);
    await watcher.check();
    assert.equal(f.calls.length, 1);
    f.advance(1);
    await watcher.check();
    assert.equal(f.calls.length, 2, "the original polling deadline still triggers a network request");
    assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
  }
});

test("a delayed silent baseline preserves the cached response's polling deadline", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.prepareForeground();
  await watcher.client.page(firstPage());
  f.rows([updated("2", f.advance(30_000)), thread()]);
  await watcher.sync();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.deliveries, []);
  assert.equal((await f.state()).nextPollAt, epoch + 60_000);
  f.advance(30_000);
  await watcher.check();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
});

test("quota-exhausting foreground responses establish silent baselines without hiding later arrivals", async t => {
  for (const initialRows of [[], [thread()]]) {
    const f = await fixture(t);
    const watcher = f.make();
    const inbox = new Inbox(watcher.client, { mode: "unread" });
    t.after(() => inbox.close());
    f.response(() => http(initialRows, {
      date: new Date(epoch).toUTCString(),
      "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((epoch + 600_000) / 1000),
    }));
    await watcher.prepareForeground();
    await inbox.refresh();
    await watcher.sync();
    assert.equal(f.calls.length, 1);
    assert.equal(watcher.snapshot().state, "watching");
    assert.equal((await f.state()).watermark, epoch);
    assert.equal((await f.state()).error, null);
    assert.equal(f.deliveries.length, 0);
    await assert.rejects(watcher.client.page(firstPage()), { code: "rate_limited" });
    assert.equal(f.calls.length, 1);

    f.response(undefined);
    f.rows([updated("2", epoch + 1000), ...initialRows]);
    f.advance(watcher.client.blockedUntil - f.advance(0));
    await watcher.check();
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
  }
});

test("an established watcher immediately delivers fresh cached activity even when the response exhausts quota", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  const inbox = new Inbox(watcher.client, { mode: "unread" });
  t.after(() => inbox.close());
  const time = f.advance(60_000);
  f.response(() => http([updated("2", time), thread()], { "x-ratelimit-remaining": "0" }));
  await inbox.refresh();
  await watcher.sync();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2"]);
  assert.equal((await f.state()).error, null);
  assert.ok((await f.state()).nextPollAt >= watcher.client.blockedUntil);
  await watcher.sync();
  await watcher.check();
  assert.equal(f.calls.length, 2);
  assert.equal(f.deliveries.length, 1);
});

test("complete foreground scans can deliver across cached pages when the final response exhausts quota", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  const inbox = new Inbox(watcher.client, { mode: "unread" });
  t.after(() => inbox.close());
  const backlog = Array.from({ length: 50 }, (_, index) => thread(String(index + 1)));
  f.response(args => args.at(-1).includes("page=1") ? http(backlog, { link: next }) : http([thread("51")]));
  await watcher.prepareForeground();
  await inbox.refresh();
  await inbox.more();
  await watcher.sync();
  const time = f.advance(60_000);
  const arrivals = Array.from({ length: 51 }, (_, index) => updated(String(100 + index), time - index));
  f.response(args => args.at(-1).includes("page=1") ? http(arrivals.slice(0, 50), { link: next })
    : http(arrivals.slice(50), { "x-ratelimit-remaining": "0" }));
  await inbox.refresh();
  await watcher.sync();
  assert.equal(f.calls.length, 4, "both refreshed pages are consumed from cache");
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["51 new notifications"]);
  assert.equal((await f.state()).error, null);
  await assert.rejects(watcher.client.page(firstPage()), { code: "rate_limited" });
  assert.equal(f.calls.length, 4);
});

test("quota-paused scans reject missing and stale continuations without committing a partial baseline or watermark", async t => {
  for (const cachedContinuation of [false, true]) {
    const f = await fixture(t);
    const watcher = f.make();
    const inbox = new Inbox(watcher.client, { mode: "unread" });
    t.after(() => inbox.close());
    if (cachedContinuation) {
      const backlog = Array.from({ length: 50 }, (_, index) => thread(String(index + 1)));
      f.response(args => args.at(-1).includes("page=1") ? http(backlog, { link: next }) : http([thread("51")]));
      await watcher.check();
      assert.equal(f.calls.length, 2);
    }
    const time = f.advance(1000);
    const arrivals = Array.from({ length: 50 }, (_, index) => updated(String(100 + index), time));
    f.response(() => http(arrivals, { link: next, "x-ratelimit-remaining": "0" }));
    await watcher.prepareForeground();
    await inbox.refresh({ force: true });
    const before = f.calls.length;
    await watcher.sync();
    assert.equal(f.calls.length, before, "a missing or stale continuation must not trigger an upstream request");
    assert.equal((await f.state()).watermark, cachedContinuation ? epoch : null);
    assert.equal((await f.state()).error.includes("rate limit"), true);
    assert.equal(f.deliveries.length, 0);
  }
});

test("foreground alerts scan all new activity pages without changing the canvas's loaded selection", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  const inbox = new Inbox(watcher.client, { mode: "unread", query: "notification 2" });
  t.after(() => inbox.close());
  await watcher.prepareForeground();
  await inbox.refresh();
  await watcher.sync();
  const time = f.advance(60_000);
  const arrivals = Array.from({ length: 60 }, (_, index) => updated(String(index + 2), time));
  f.response(args => args.at(-1).includes("page=1") ? http(arrivals.slice(0, 50), { link: next }) :
    http([...arrivals.slice(50), thread()]));
  await inbox.refresh();
  await watcher.sync();
  assert.equal(f.calls.length, 3, "one shared first-page read and one desktop-only continuation");
  assert.equal(inbox.pages.length, 1);
  assert.equal(inbox.filters.query, "notification 2");
  assert.equal(inbox.summary().loaded, 50);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].body, "60 new notifications");
});

test("desktop scans continue past older rows before checkpointing later-page activity", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  const time = f.advance();
  const first = [
    updated("2", time),
    ...Array.from({ length: 49 }, (_, index) => updated(String(index + 3), epoch - 1000)),
  ];
  const second = [updated("99", time - 1000)];
  f.response(args => args.at(-1).includes("page=1") ? http(first, { link: next }) : http(second));
  await watcher.check();
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2", "#42 Synthetic notification 99"]);
  assert.equal((await f.state()).watermark, time);
  f.response(() => http([first[0], ...second]));
  f.advance();
  await watcher.check();
  assert.equal(f.deliveries.length, 2, "already checkpointed activity is not replayed");
});

test("a failed page beyond an older row leaves the activity checkpoint unchanged", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  const before = await f.state();
  const time = f.advance();
  const first = [updated("2", time), updated("3", epoch - 1000)];
  let fail = true;
  f.response(args => args.at(-1).includes("page=1") ? http(first, { link: next }) :
    fail ? http({}, {}, 503) : http([updated("4", time - 1000)]));
  await watcher.check();
  assert.equal(watcher.snapshot().state, "error");
  assert.equal((await f.state()).watermark, before.watermark);
  assert.deepEqual((await f.state()).fingerprints, before.fingerprints);
  assert.deepEqual(f.deliveries, []);
  fail = false;
  f.advance();
  await watcher.check();
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2", "#42 Synthetic notification 4"]);
});

test("silent baselines include later-page boundary fingerprints despite older rows on the first page", async t => {
  const f = await fixture(t);
  const first = [updated("1", epoch), updated("2", epoch - 1000)];
  const second = [updated("3", epoch)];
  f.response(args => args.at(-1).includes("page=1") ? http(first, { link: next }) : http(second));
  const watcher = f.make();
  await watcher.check();
  assert.equal(f.calls.length, 2);
  assert.equal((await f.state()).watermark, epoch);
  assert.equal((await f.state()).fingerprints.length, 2);
  assert.deepEqual(f.deliveries, []);
  second.push(updated("4", epoch));
  f.advance();
  await watcher.check();
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 4"]);
});

test("silent baselines include newer pre-snapshot activity on later unordered pages", async t => {
  for (const skew of [-3_600_000, 0, 3_600_000]) {
    const f = await fixture(t);
    f.advance(skew);
    const first = [updated("1", epoch - 120_000), updated("2", epoch - 180_000)];
    const second = [updated("3", epoch - 60_000)];
    f.response(args => args.at(-1).includes("page=1")
      ? http(first, { link: next, date: new Date(epoch).toUTCString() }) : http(second));
    const watcher = f.make();
    await watcher.check();
    assert.equal((await f.state()).watermark, epoch - 60_000);
    assert.equal((await f.state()).fingerprints.length, 1);
    f.advance();
    await watcher.check();
    assert.deepEqual(f.deliveries, [], "unchanged later-page backlog remains silent on the next poll");
    first.unshift(updated("4", epoch + 1000));
    second.push(updated("5", epoch - 60_000));
    f.advance();
    await watcher.check();
    assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 4", "#42 Synthetic notification 5"]);
  }
});

test("newer later-page baseline activity requires the first response's valid API Date", async t => {
  for (const date of [undefined, "invalid"]) {
    const f = await fixture(t);
    const first = [updated("1", epoch - 120_000), updated("2", epoch - 180_000)];
    const second = [updated("3", epoch - 60_000)];
    let firstDate = date;
    f.response(args => args.at(-1).includes("page=1")
      ? http(first, { link: next, ...(firstDate === undefined ? {} : { date: firstDate }) })
      : http(second, { date: new Date(epoch).toUTCString() }));
    const watcher = f.make();
    await watcher.check();
    assert.equal((await f.state()).watermark, null);
    assert.deepEqual((await f.state()).fingerprints, []);
    assert.equal(watcher.snapshot().state, "error");
    assert.match(watcher.snapshot().message, /valid snapshot timestamp/);
    assert.deepEqual(f.deliveries, []);
    firstDate = new Date(epoch).toUTCString();
    f.advance();
    await watcher.check();
    assert.equal(watcher.snapshot().state, "watching");
    assert.equal((await f.state()).watermark, epoch - 60_000);
    f.advance();
    await watcher.check();
    assert.deepEqual(f.deliveries, []);
  }
});

test("a fresh first page cannot advance the watermark past arrivals hidden by an older cached continuation", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  const inbox = new Inbox(watcher.client, { mode: "unread" });
  t.after(() => inbox.close());
  const backlog = Array.from({ length: 51 }, (_, index) => updated(String(index + 1), epoch));
  let rows = backlog;
  f.response(args => {
    const page = Number(new URL(args.at(-1), "https://api.github.com").searchParams.get("page"));
    const offset = (page - 1) * 50;
    return http(rows.slice(offset, offset + 50), offset + 50 < rows.length
      ? { link: `<https://api.github.com/notifications?all=false&per_page=50&page=${page + 1}>; rel="next"` } : {});
  });
  await watcher.prepareForeground();
  await inbox.refresh();
  await watcher.sync();
  assert.equal(f.calls.length, 2);
  assert.equal(f.deliveries.length, 0);

  const time = f.advance(1000);
  rows = [...Array.from({ length: 60 }, (_, index) => updated(String(100 + index), time - index)), ...backlog];
  await inbox.refresh({ force: true });
  await watcher.sync();
  assert.equal(f.calls.length, 5, "the stale continuation must be revalidated before scanning the final page");
  assert.equal(f.advance(0), epoch + 60_000, "revalidation respects the cached polling deadline");
  assert.equal((await f.state()).nextPollAt, epoch + 120_000, "the background delay starts after the scan finishes");
  assert.equal(inbox.pages.length, 1);
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["60 new notifications"]);
  f.advance();
  await inbox.refresh();
  await watcher.sync();
  assert.deepEqual(f.deliveries.map(alert => alert.body), ["60 new notifications"]);
});

test("enabling desktop alerts silently baselines activity missing from a pre-activation foreground cache", async t => {
  const f = await fixture(t, { enabled: false });
  const watcher = f.make();
  const inbox = new Inbox(watcher.client, { mode: "unread" });
  t.after(() => inbox.close());
  await inbox.refresh();
  f.rows([updated("2", f.advance(1000)), thread()]);
  await f.preferences.update({ desktopNotifications: true });
  await watcher.check();
  assert.equal(f.calls.length, 2, "the baseline must revalidate the pre-activation cache");
  assert.equal(f.advance(0), epoch + 60_000);
  assert.equal((await f.state()).nextPollAt, epoch + 120_000);
  assert.equal(f.deliveries.length, 0);
  f.advance(1000);
  await inbox.refresh({ force: true });
  await watcher.sync();
  assert.equal(f.deliveries.length, 0);
});

test("closing the final panel cancels an outstanding baseline cache wait without delivering or retrying", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { enabled: false });
  const watcher = f.make();
  await watcher.client.page(firstPage());
  await f.preferences.update({ desktopNotifications: true });
  let waiting;
  const started = new Promise(resolve => { waiting = resolve; });
  watcher.client.sleep = (_delay, _value, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    waiting();
  });
  const syncing = watcher.sync();
  await started;
  await watcher.close();
  await syncing;
  assert.equal(f.calls.length, 1);
  assert.equal(f.deliveries.length, 0);
  assert.deepEqual(f.logs, []);
  assert.equal(watcher.pending, undefined);
  assert.equal(watcher.foregroundPending, undefined);
  assert.equal((await f.state()).watermark, null);
});

test("a watcher can reuse a foreground response prepared for its activation generation as a silent baseline", async t => {
  const f = await fixture(t);
  let scheduled;
  const watcher = f.make({ schedule: fn => { scheduled = fn; return 0; } });
  await watcher.prepareForeground();
  await watcher.client.page(firstPage());
  scheduled();
  await watcher.pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.deliveries.length, 0);
  assert.equal((await f.state()).watermark, epoch);
});

test("foreground synchronization preserves opt-in and at-most-once delivery across sessions", async t => {
  const f = await fixture(t, { enabled: false });
  const one = f.make();
  await one.sync();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.directory), []);
  await f.preferences.update({ desktopNotifications: true });
  const two = f.make();
  await Promise.all([one.sync(), two.sync()]);
  assert.equal(f.deliveries.length, 0);
  f.rows([updated("2", f.advance(60_000)), thread()]);
  await Promise.all([one.client.page(firstPage()), two.client.page(firstPage())]);
  await Promise.all([one.sync(), two.sync()]);
  await two.sync();
  assert.equal(f.deliveries.length, 1);
});

test("foreground synchronization retries contention on the timer and consumes the newer session's cache", async t => {
  const f = await fixture(t);
  const clock = watcherTimers();
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const older = f.make({ notify: async message => {
    f.deliveries.push(message);
    entered();
    await held;
  } });
  const newer = f.make({ schedule: clock.schedule, cancel: clock.cancel });
  const inbox = new Inbox(newer.client, { mode: "unread" });
  t.after(() => inbox.close());
  await older.check();
  await newer.check();
  const olderTime = f.advance(60_000);
  f.rows([updated("2", olderTime), thread()]);
  const delivering = older.check();
  try {
    await started;
    const newerTime = f.advance(1000);
    f.rows([updated("3", newerTime), updated("2", olderTime), thread()]);
    await newer.prepareForeground();
    await inbox.refresh();
    await newer.sync();
    assert.equal(newer.snapshot().state, "shared");
    assert.equal(newer.foregroundRequested, true);
    assert.equal(newer.foregroundPending, undefined, "contention must finish the attempt rather than spin");
    const calls = f.calls.length;
    assert.equal(calls, 3);
    for (let attempt = 0; attempt < 2; attempt++) {
      f.advance(5000);
      await clock.fire(newer);
      assert.equal(newer.foregroundRequested, true);
      assert.equal(newer.foregroundPending, undefined);
      assert.equal(f.calls.length, calls);
      assert.equal(f.deliveries.length, 1);
    }
    newer.add("another-panel");
    await clock.fire(newer, 0);
    assert.equal(newer.foregroundRequested, true, "waking a watcher must retain its foreground retry");
    await newer.remove("another-panel");
    assert.equal(newer.foregroundRequested, true, "closing one of several panels must not cancel the retry");
    release();
    await delivering;
    f.advance(5000);
    assert.ok(f.advance(0) < (await f.state()).nextPollAt);
    await clock.fire(newer);
    assert.equal(f.calls.length, calls, "the deferred foreground scan reuses its fresh cache");
    assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 2", "#42 Synthetic notification 3"]);
    assert.equal(newer.foregroundRequested, false);
    assert.equal((await f.state()).watermark, newerTime);
    f.rows([updated("2", olderTime), thread()]);
    f.advance(5000);
    await clock.fire(newer);
    assert.equal(f.calls.length, calls);
    assert.equal(f.deliveries.length, 2);
    await newer.sync();
    assert.equal(f.deliveries.length, 2, "already claimed cache contents are not delivered again");
  } finally {
    release();
    await delivering;
  }
});

test("disabling or closing the watcher clears a foreground retry retained after lock contention", async t => {
  for (const action of ["disable", "close"]) {
    const f = await fixture(t);
    const clock = watcherTimers();
    const watcher = f.make({ schedule: clock.schedule, cancel: clock.cancel });
    await watcher.check();
    f.rows([updated("2", f.advance(60_000)), thread()]);
    await watcher.client.page(firstPage());
    const release = await acquireLock(join(f.directory, ".desktop.lock"));
    assert.ok(release);
    try {
      await watcher.sync();
      assert.equal(watcher.foregroundRequested, true);
      if (action === "disable") {
        watcher.wake(await f.preferences.update({ desktopNotifications: false }));
        assert.equal(watcher.foregroundRequested, false);
        await clock.fire(watcher, 0);
        assert.equal(watcher.snapshot().state, "off");
      } else {
        await watcher.close();
        assert.equal(watcher.foregroundRequested, false);
        assert.equal(clock.timers.size, 0);
      }
    } finally {
      await release();
    }
    if (action === "disable") {
      f.advance(5000);
      await clock.fire(watcher);
    }
    assert.equal(f.calls.length, 2);
    assert.equal(f.deliveries.length, 0);
  }
});

test("a deferred foreground retry honors an error reservation written by the lock owner", async t => {
  const f = await fixture(t);
  const clock = watcherTimers();
  let entered;
  let release;
  let failedAttempts = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const owner = f.make({ notify: async () => {
    failedAttempts++;
    entered();
    await held;
    throw new InboxError("desktop_delivery", "Synthetic delivery failure", 503);
  } });
  const contender = f.make({ schedule: clock.schedule, cancel: clock.cancel });
  await owner.check();
  await contender.check();
  const time = f.advance(60_000);
  f.rows([updated("2", time), thread()]);
  const delivering = owner.check();
  try {
    await started;
    f.rows([updated("3", f.advance(1000)), updated("2", time), thread()]);
    await contender.client.page(firstPage());
    await contender.sync();
    assert.equal(contender.foregroundRequested, true);
    const calls = f.calls.length;
    release();
    await delivering;
    const retryAt = (await f.state()).nextPollAt;
    f.advance(5000);
    await clock.fire(contender);
    assert.equal(contender.foregroundRequested, false);
    assert.equal(contender.snapshot().state, "error");
    assert.equal(f.calls.length, calls);
    assert.equal(f.deliveries.length, 0);
    f.advance(retryAt - f.advance(0));
    await clock.fire(contender);
    assert.equal(failedAttempts, 1);
    assert.deepEqual(f.deliveries.map(alert => alert.body), ["#42 Synthetic notification 3"]);
  } finally {
    release();
    await delivering;
  }
});

test("foreground synchronization honors interrupted, legacy and failed-delivery reservations", async t => {
  for (const kind of ["interrupted", "legacy", "delivery"]) {
    const f = await fixture(t);
    let attempts = 0;
    const watcher = f.make({ notify: async () => { attempts++; throw new Error("Synthetic delivery failure"); } });
    await watcher.sync();
    if (kind === "delivery") {
      f.rows([updated("2", f.advance(60_000)), thread()]);
      await watcher.sync();
      assert.equal(attempts, 1);
    } else {
      const state = await f.state();
      if (kind === "interrupted") state.polling = true;
      else delete state.polling;
      await writeFile(join(f.directory, "desktop-state.json"), JSON.stringify(state));
    }
    const calls = f.calls.length;
    f.advance(1000);
    await watcher.sync();
    assert.equal(f.calls.length, calls);
    assert.equal(attempts, kind === "delivery" ? 1 : 0);
    f.advance(120_000);
    await watcher.sync();
    assert.equal(f.calls.length, calls + 1);
    assert.equal(attempts, kind === "delivery" ? 1 : 0, "failed deliveries are not replayed");
  }
});

test("foreground requests arriving during delivery coalesce into a follow-up check and close drains it", async t => {
  const f = await fixture(t);
  let started;
  let release;
  const delivering = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const watcher = f.make({ notify: async options => {
    f.deliveries.push(options);
    if (f.deliveries.length === 1) {
      started();
      await held;
    }
  } });
  await watcher.sync();
  f.rows([updated("2", f.advance(60_000)), thread()]);
  const first = watcher.sync();
  try {
    await delivering;
    f.rows([updated("3", f.advance(60_000)), thread()]);
    const second = watcher.sync();
    assert.equal(second, first);
    release();
    await first;
    assert.deepEqual(f.deliveries.map(alert => alert.body),
      ["#42 Synthetic notification 2", "#42 Synthetic notification 3"]);
    const closing = watcher.sync();
    await watcher.close();
    await closing;
    assert.equal(watcher.pending, undefined);
    assert.equal(watcher.foregroundPending, undefined);
    const calls = f.calls.length;
    await watcher.sync();
    assert.equal(f.calls.length, calls);
  } finally {
    release();
  }
});

test("invalid foreground reservation metadata fails closed", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  await watcher.check();
  const content = JSON.stringify({ ...await f.state(), polling: "false" });
  await writeFile(join(f.directory, "desktop-state.json"), content);
  await watcher.sync();
  assert.equal(watcher.snapshot().state, "error");
  assert.equal(f.calls.length, 1);
  assert.equal(await readFile(join(f.directory, "desktop-state.json"), "utf8"), content);
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
    assert.deepEqual(f.deliveries.map(alert => alert.url), [
      "https://github.com/example/widgets/issues/7",
      "https://github.com/example/widgets/pull/8",
      "https://github.com/notifications",
      "https://github.com/example/widgets/releases",
    ]);
    assert.equal(f.calls.length, 2, "issue and PR links need no extra API requests");
  }
});

for (const platform of ["win32", "darwin"]) test(`${platform} check alerts resolve direct, suite and inferred destinations after checkpointing`, async t => {
  for (const kind of ["direct", "suite", "inferred"]) {
    const f = await fixture(t);
    const watcher = f.make({ platform, findNotifier: async () => "/opt/homebrew/bin/terminal-notifier" });
    await watcher.check();
    const time = f.advance();
    const row = updated("2", time);
    row.subject = {
      type: "CheckSuite", title: "Synthetic build workflow run failed for main branch",
      url: kind === "direct" ? "https://api.github.com/repos/example/widgets/actions/runs/123"
        : kind === "suite" ? "https://api.github.com/repos/example/widgets/check-suites/7" : null,
    };
    f.response(async args => {
      const endpoint = args.at(-1);
      if (endpoint.startsWith("/notifications?")) return http([row, thread()]);
      assert.equal((await f.state()).watermark, time, "claim precedes optional link lookups");
      assert.doesNotMatch(endpoint, /\/logs/);
      if (endpoint.includes("/jobs?")) return http({ total_count: 1, jobs: [workflowJob()] });
      if (endpoint.includes("/actions/runs?")) return http({
        total_count: 1, workflow_runs: [workflowRun({ check_suite_id: 7, updated_at: new Date(time).toISOString() })],
      });
      return http({ status: "completed", conclusion: "failure" });
    });
    await watcher.check();
    assert.equal(watcher.snapshot().state, "watching");
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].url, "https://github.com/example/widgets/actions/runs/123/job/456");
    assert.equal(Object.hasOwn(f.deliveries[0], "item"), false);
    assert.deepEqual(f.logs, []);
    assert.doesNotMatch(JSON.stringify(await f.state()), /github\.com|Synthetic|example\/widgets|url|\/job\//);
    f.advance();
    await watcher.check();
    assert.equal(f.deliveries.length, 1, "resolved alerts are not replayed");
  }
});

test("Windows check alerts retain fresh failed-job destinations during inherited backoff", async t => {
  for (const kind of ["direct", "suite", "inferred"]) {
    const f = await fixture(t);
    const reader = f.make({ platform: "win32" });
    const writer = f.make({ platform: "win32" });
    await reader.check();
    await writer.check();
    const time = f.advance();
    const row = updated("2", time);
    row.subject = {
      type: "CheckSuite", title: "Synthetic build workflow run failed for main branch",
      url: kind === "direct" ? "https://api.github.com/repos/example/widgets/actions/runs/123"
        : kind === "suite" ? "https://api.github.com/repos/example/widgets/check-suites/7" : null,
    };
    f.response(args => {
      const endpoint = args.at(-1);
      if (endpoint.startsWith("/notifications?")) {
        return endpoint.includes("all=true") ? http({}, { "retry-after": "600" }, 429) : http([row, thread()]);
      }
      if (endpoint.includes("/jobs?")) return http({ total_count: 1, jobs: [workflowJob()] });
      if (endpoint.includes("/actions/runs?")) return http({
        total_count: 1, workflow_runs: [workflowRun({ check_suite_id: 7, updated_at: new Date(time).toISOString() })],
      });
      return http({ status: "completed", conclusion: "failure" });
    });
    const page = await reader.client.page(firstPage(), undefined, { force: true });
    const item = page.items[0];
    await reader.client.refreshSubjects([item]);
    const before = reader.client.subjectSnapshot(item);
    assert.equal(before.subjectLinkTarget, "job");
    await assert.rejects(writer.client.page(firstPage({ mode: "inbox" }), undefined, { force: true }),
      { code: "rate_limited" });
    await writer.check();
    assert.equal(reader.client.blockedUntil, 0, "backoff will be inherited when the cached arrival is processed");
    const calls = f.calls.length;
    await reader.sync();
    assert.equal(f.calls.length, calls);
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].url, before.url);
    assert.deepEqual(reader.client.subjectSnapshot(item), before);
    assert.deepEqual(f.logs, []);
    assert.equal((await f.state()).blockedUntil, writer.client.serverBlockedUntil);
    assert.equal((await f.state()).nextPollAt, writer.client.serverBlockedUntil);
    await reader.sync();
    assert.equal(f.calls.length, calls);
    assert.equal(f.deliveries.length, 1, "cached link reuse must not replay activity");
  }
});

for (const platform of ["win32", "darwin"]) test(`${platform} check alerts preserve safe fallbacks and report metadata failures without content`, async t => {
  for (const kind of ["run", "ambiguous", "denied", "unsafe", "jobs-denied"]) {
    const f = await fixture(t);
    const watcher = f.make({ platform, findNotifier: async () => "/opt/homebrew/bin/terminal-notifier" });
    await watcher.check();
    const time = f.advance();
    const row = updated("2", time);
    row.subject = {
      type: "CheckSuite", title: "Synthetic build workflow run failed for main branch",
      url: "https://api.github.com/repos/example/widgets/check-suites/7",
    };
    f.response(args => {
      const endpoint = args.at(-1);
      if (endpoint.startsWith("/notifications?")) return http([row, thread()]);
      if (endpoint.includes("/actions/runs?")) {
        if (kind === "denied") return http({ message: "private upstream response" }, {}, 403);
        if (kind === "ambiguous") return http({ total_count: 0, workflow_runs: [] });
        return http({ total_count: 1, workflow_runs: [workflowRun({
          check_suite_id: 7,
          html_url: kind === "unsafe" ? "https://untrusted.invalid/" : "https://github.com/example/widgets/actions/runs/123",
        })] });
      }
      if (endpoint.includes("/jobs?")) return kind === "jobs-denied"
        ? http({ message: "private upstream response" }, {}, 403) : http({ total_count: 0, jobs: [] });
      return http({ status: "completed", conclusion: "failure" });
    });
    await watcher.check();
    assert.equal(watcher.snapshot().state, "watching");
    assert.equal(f.deliveries.length, 1);
    const expected = ["run", "jobs-denied"].includes(kind) ? "https://github.com/example/widgets/actions/runs/123/attempts/1"
      : `https://github.com/example/widgets/actions?${new URLSearchParams({ query: 'workflow:"Synthetic build" branch:"main" is:failure' })}`;
    assert.equal(f.deliveries[0].url, expected);
    assert.equal(f.logs.length, ["denied", "unsafe", "jobs-denied"].includes(kind) ? 1 : 0);
    if (f.logs.length) assert.equal(f.logs[0][1].level, "warning");
    assert.doesNotMatch(JSON.stringify(f.logs), /private|Synthetic|example\/widgets|https:/);
  }
});

for (const platform of ["win32", "darwin"]) test(`${platform} check link lookups respect backoff and cancellation without replay or opt-out delivery`, async t => {
  for (const kind of ["rate-limited", "disabled", "closed"]) {
    const f = await fixture(t);
    const watcher = f.make({ platform, findNotifier: async () => "/opt/homebrew/bin/terminal-notifier" });
    await watcher.check();
    const time = f.advance();
    const row = updated("2", time);
    row.subject = {
      type: "CheckSuite", title: "Synthetic build workflow run failed for main branch",
      url: "https://api.github.com/repos/example/widgets/check-suites/7",
    };
    let changed = false;
    f.response(async args => {
      const endpoint = args.at(-1);
      if (endpoint.startsWith("/notifications?")) return http([row, thread()]);
      if (endpoint.includes("/actions/runs?")) {
        if (!changed) {
          changed = true;
          if (kind === "disabled") await f.preferences.update({ desktopNotifications: false });
          if (kind === "closed") watcher.controller.abort();
        }
        return kind === "rate-limited" ? http({}, { "retry-after": "600" }, 429)
          : http({ total_count: 1, workflow_runs: [workflowRun({ check_suite_id: 7 })] });
      }
      if (endpoint.includes("/jobs?")) return http({ total_count: 0, jobs: [] });
      return http({ status: "completed", conclusion: "failure" });
    });
    await watcher.check();
    assert.equal((await f.state()).watermark, time);
    if (kind === "rate-limited") {
      assert.equal(f.deliveries.length, 1);
      assert.match(f.deliveries[0].url, /\/actions\?query=/);
      const calls = f.calls.length;
      f.advance();
      await watcher.check();
      assert.equal(f.calls.length, calls, "link lookup backoff also pauses later inbox requests");
      assert.equal(f.deliveries.length, 1);
    } else {
      assert.equal(f.deliveries.length, 0);
      if (kind === "closed") {
        f.advance();
        await watcher.check();
        assert.equal(f.deliveries.length, 0, "an interrupted lookup does not replay the claimed alert");
      }
    }
  }
});

for (const platform of ["win32", "darwin"]) test(`${platform} burst clicks open the repository inbox without resolving individual check links`, async t => {
  const f = await fixture(t);
  const watcher = f.make({ platform, findNotifier: async () => "/opt/homebrew/bin/terminal-notifier" });
  await watcher.check();
  const time = f.advance();
  f.rows(Array.from({ length: 5 }, (_, i) => thread(String(i + 2), {
    updated_at: new Date(time).toISOString(),
    subject: { type: "CheckSuite", title: "Synthetic build workflow run failed for main branch", url: null },
  })));
  await watcher.check();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].body, "5 new notifications");
  assert.equal(f.deliveries[0].url, "https://github.com/notifications?query=repo%3Aexample%2Fwidgets");
  assert.equal(f.calls.length, 2);
});

test("Windows lookup backoff survives interruption and blocks separate watcher clients until its deadline", async t => {
  for (const interrupted of [false, true]) {
    const f = await fixture(t);
    const one = f.make({ platform: "win32" });
    const two = f.make({ platform: "win32" });
    await one.check();
    await two.check();
    const time = f.advance();
    const row = thread("2", {
      updated_at: new Date(time).toISOString(),
      subject: { type: "CheckSuite", title: "Synthetic build workflow run failed for main branch", url: null },
    });
    f.response(args => args.at(-1).startsWith("/notifications?") ? http([row, thread()])
      : http({}, { "retry-after": "600" }, 429));
    if (interrupted) {
      const refreshSubjects = one.client.refreshSubjects.bind(one.client);
      one.client.refreshSubjects = async (...args) => {
        await refreshSubjects(...args);
        one.controller.abort();
        throw new InboxError("closed", "Synthetic interrupted lookup", 410);
      };
    }
    await one.check();
    const deadline = time + 600_000;
    assert.equal(one.client.blockedUntil, deadline);
    assert.equal((await f.state()).blockedUntil, deadline);
    assert.equal((await f.state()).nextPollAt, deadline);
    assert.equal((await f.state()).error, null, "a fallback alert is not a failed inbox poll");
    assert.equal(f.deliveries.length, interrupted ? 0 : 1);
    if (!interrupted) assert.match(f.deliveries[0].url, /\/actions\?query=/);
    await one.close();
    const calls = f.calls.length;
    await two.prepareForeground();
    await assert.rejects(two.client.page(firstPage(), undefined, { force: true }), { code: "rate_limited" });
    for (const delay of [0, POLL_MS, 600_000 - POLL_MS - 1]) {
      f.advance(delay);
      await two.check();
      await two.sync();
      assert.equal(f.calls.length, calls, "neither background nor foreground checks may contact GitHub early");
      assert.equal((await f.state()).nextPollAt, deadline);
    }
    f.advance(1);
    f.response(undefined);
    f.rows([updated("3", deadline), row, thread()]);
    await two.check();
    assert.equal(f.calls.length, calls + 1);
    assert.equal(f.deliveries.length, interrupted ? 1 : 2);
    assert.equal(f.deliveries.at(-1).body, "#42 Synthetic notification 3", "claimed activity is never replayed");
  }
});

test("Windows shared lookup backoff permits fresh-cache delivery without shortening the shared deadline", async t => {
  const f = await fixture(t);
  const one = f.make({ platform: "win32" });
  const two = f.make({ platform: "win32" });
  const noCache = f.make({ platform: "win32" });
  await one.check();
  await two.check();
  const time = f.advance();
  const row = thread("2", {
    updated_at: new Date(time).toISOString(),
    subject: { type: "CheckSuite", title: "Synthetic build workflow run failed for main branch", url: null },
  });
  const later = updated("3", f.advance(1000));
  f.rows([later, row, thread()]);
  await two.client.page(firstPage(), undefined, { force: true });
  f.response(args => args.at(-1).startsWith("/notifications?") ? http([row, thread()])
    : http({}, { "retry-after": "600" }, 429));
  await one.check();
  const deadline = one.client.blockedUntil;
  const calls = f.calls.length;
  await noCache.sync();
  assert.equal((await f.state()).error, null, "a watcher without a cache must not poison fresh-cache reuse");
  await two.sync();
  assert.equal(f.calls.length, calls, "a valid cached page is still usable during shared backoff");
  assert.equal(two.client.blockedUntil, deadline);
  assert.equal((await f.state()).blockedUntil, deadline);
  assert.equal((await f.state()).nextPollAt, deadline);
  assert.equal((await f.state()).error, null);
  assert.deepEqual(f.deliveries.map(alert => alert.body), [
    "Synthetic build workflow run failed for main branch", "#42 Synthetic notification 3",
  ]);
  await assert.rejects(two.client.page(firstPage(), undefined, { force: true }), { code: "rate_limited" });
  assert.equal(f.calls.length, calls);
});

test("Windows lookup backoff without a fresh unread cache stays quiet and resumes at the original deadline", async t => {
  for (const cache of ["missing", "stale", "invalidated"]) {
    const f = await fixture(t);
    const one = f.make({ platform: "win32" });
    const two = f.make({ platform: "win32" });
    await one.check();
    await two.check();
    if (cache !== "missing") {
      await two.client.page(firstPage());
      if (cache === "invalidated") {
        for (const page of two.client.cache.values()) page.invalidated = true;
      }
    }
    const time = f.advance();
    const row = thread("2", {
      updated_at: new Date(time).toISOString(),
      subject: { type: "CheckSuite", title: "Synthetic build workflow run failed for main branch", url: null },
    });
    f.response(args => args.at(-1).startsWith("/notifications?") ? http([row, thread()])
      : http({}, { "retry-after": "600" }, 429));
    await one.check();
    const checkpoint = await f.state();
    assert.equal(checkpoint.nextPollAt, time + 600_000);
    const calls = f.calls.length;
    f.advance(600_000 - 1);
    await two.sync();
    await two.sync();
    const skipped = await f.state();
    assert.equal(f.calls.length, calls);
    assert.equal(skipped.error, null);
    assert.equal(skipped.polling, checkpoint.polling);
    assert.equal(skipped.nextPollAt, checkpoint.nextPollAt);
    assert.equal(skipped.watermark, checkpoint.watermark);
    assert.deepEqual(skipped.fingerprints, checkpoint.fingerprints);
    assert.equal(two.snapshot().state, "watching");
    assert.equal(f.logs.some(([, options]) => options.level === "error"), false);
    const resumedAt = f.advance(1);
    f.response(undefined);
    f.rows([updated("3", resumedAt), row, thread()]);
    await two.check();
    assert.equal(f.calls.length, calls + 1);
    assert.equal(f.deliveries.length, 2);
    assert.equal(f.deliveries.at(-1).body, "#42 Synthetic notification 3");
  }
});

test("Windows client-local read and write failures never become another client's rate limit", async t => {
  for (const operation of ["page", "markRead", "markDone"]) {
    for (const failure of ["network", "permission", "authentication", "http"]) {
      const f = await fixture(t);
      const one = f.make({ platform: "win32" });
      const two = f.make({ platform: "win32" });
      await one.check();
      await two.check();
      const reservation = (await f.state()).nextPollAt;
      f.advance(1000);
      f.response(() => {
        if (failure === "network") throw new InboxError("gh_failed", "Synthetic network failure", 502);
        return http({}, {}, { permission: 403, authentication: 401, http: 500 }[failure]);
      });
      const failed = () => operation === "page" ? one.client.page(firstPage(), undefined, { force: true })
        : one.client[operation]("1");
      await assert.rejects(failed());
      assert.ok(one.client.blockedUntil > f.advance(0));
      const calls = f.calls.length;
      await assert.rejects(failed());
      assert.equal(f.calls.length, calls, "the failed client retains its own retry delay");
      await one.check();
      await one.sync();
      const state = await f.state();
      assert.equal(state.blockedUntil, 0);
      assert.equal(state.nextPollAt, reservation);
      assert.equal(state.error, null);
      await two.prepareForeground();
      assert.equal(two.client.blockedUntil, 0);
      f.response(args => args.includes("GET") ? http([thread()]) : http(null, {}, args.includes("DELETE") ? 204 : 205));
      await two.client.page(firstPage(), undefined, { force: true });
      await two.client.markRead("1");
      await two.client.markDone("2");
      assert.equal(f.calls.length, calls + 3);
    }
  }
});

test("Windows polling failures retain the shared reservation without rate-limiting healthy clients", async t => {
  const f = await fixture(t);
  const one = f.make({ platform: "win32" });
  const two = f.make({ platform: "win32" });
  await one.check();
  await two.check();
  const time = f.advance(POLL_MS);
  f.response(() => http({}, {}, 500));
  await one.check();
  const state = await f.state();
  assert.equal(state.nextPollAt, time + RETRY_MS);
  assert.equal(state.blockedUntil, 0);
  assert.match(state.error, /HTTP 500/);
  const calls = f.calls.length;
  f.response(undefined);
  await two.prepareForeground();
  assert.equal(two.client.blockedUntil, 0);
  await two.client.page(firstPage(), undefined, { force: true });
  await two.check();
  await two.sync();
  assert.equal(f.calls.length, calls + 1);
  assert.equal((await f.state()).nextPollAt, state.nextPollAt);
  assert.equal((await f.state()).error, state.error);
});

test("Windows local deferrals stop repeated background checkpoint writes without postponing other clients", async t => {
  const f = await fixture(t);
  const watcher = f.make({ platform: "win32" });
  const healthy = f.make({ platform: "win32" });
  await watcher.check();
  await healthy.check();
  f.advance(POLL_MS);
  f.response(() => http({}, {}, 503));
  await assert.rejects(watcher.client.page(firstPage(), undefined, { force: true }), { code: "github_http" });
  const deadline = watcher.client.blockedUntil;
  const reservation = await f.state();
  const calls = f.calls.length;
  let writes = 0;
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === watcher.statePath) writes++;
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await watcher.check();
    assert.equal(writes, 2, "the initial deferral reserves then restores the checkpoint");
    const deferred = writes;
    for (let count = 0; count < 4; count++) {
      f.advance(5000);
      await watcher.check();
      assert.equal(writes, deferred, "background ticks must not reserve another blocked request");
    }
    assert.equal(f.calls.length, calls);
    assert.equal((await f.state()).nextPollAt, reservation.nextPollAt);
    assert.equal((await f.state()).blockedUntil, 0);

    f.response(undefined);
    f.rows([updated("2", f.advance(0)), thread()]);
    await healthy.client.page(firstPage());
    // A newly available cache must remain usable by foreground synchronization.
    watcher.client.cache = new Map(healthy.client.cache);
    await watcher.sync();
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].body, "#42 Synthetic notification 2");
    const afterForeground = writes;
    f.advance(POLL_MS);
    await watcher.check();
    assert.equal(writes, afterForeground, "the local deferral still gates background cache misses");
    assert.equal(f.calls.length, calls + 1);

    f.rows([updated("3", f.advance(deadline - f.advance(0))), thread()]);
    await watcher.check();
    assert.equal(f.calls.length, calls + 2);
    assert.equal(f.deliveries.at(-1).body, "#42 Synthetic notification 3");
  } finally {
    fs.rename = rename;
    syncBuiltinESMExports();
  }
});

test("Windows longer shared deadlines replace stale client errors but preserve a longer local failure", async t => {
  for (const localSeconds of [120, 600, 900]) {
    const f = await fixture(t);
    const one = f.make({ platform: "win32" });
    const two = f.make({ platform: "win32" });
    await one.check();
    await two.check();
    f.advance(1000);
    f.response(() => http({}, { "x-poll-interval": String(localSeconds) }, 403));
    await assert.rejects(two.client.page(firstPage(), undefined, { force: true }), { code: "permission" });
    const localError = two.client.lastError;
    f.response(() => http({}, { "retry-after": "600" }, 429));
    await assert.rejects(one.client.page(firstPage(), undefined, { force: true }), { code: "rate_limited" });
    await one.check();
    await two.prepareForeground();
    const sharedWins = localSeconds < 600;
    assert.equal(two.client.lastError, sharedWins ? null : localError);
    const calls = f.calls.length;
    for (const request of [
      () => two.client.page(firstPage(), undefined, { force: true }),
      () => two.client.markRead("1"),
      () => two.client.markDone("2"),
    ]) {
      await assert.rejects(request(), { code: sharedWins ? "rate_limited" : "permission" });
    }
    assert.equal(f.calls.length, calls);
    assert.equal(two.client.blockedUntil, f.advance(0) + Math.max(localSeconds, 600) * 1000);
  }
});

test("Windows shared backoff accepts older checkpoints but rejects malformed deadlines without overwriting", async t => {
  for (const blockedUntil of [undefined, null, -1, "600000", {}]) {
    const f = await fixture(t);
    const watcher = f.make({ platform: "win32" });
    await watcher.check();
    const state = { ...await f.state(), blockedUntil };
    const content = JSON.stringify(state);
    await writeFile(watcher.statePath, content);
    f.rows([updated("2", f.advance()), thread()]);
    await watcher.check();
    if (blockedUntil === undefined) {
      assert.equal(watcher.snapshot().state, "watching");
      assert.equal(f.deliveries.length, 1, "an older checkpoint must not reset the activity baseline");
    } else {
      assert.equal(watcher.snapshot().state, "error");
      assert.equal(f.calls.length, 1);
      assert.equal(f.deliveries.length, 0);
      assert.equal(await readFile(watcher.statePath, "utf8"), content);
    }
  }
});

test("macOS and Linux check alerts do not fetch Windows click metadata", async t => {
  for (const platform of ["darwin", "linux"]) {
    const f = await fixture(t);
    const watcher = f.make({ platform });
    await watcher.check();
    const row = updated("2", f.advance());
    row.subject = { type: "CheckSuite", title: "Synthetic build workflow run failed for main branch", url: null };
    f.rows([row, thread()]);
    await watcher.check();
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.calls.length, 2);
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
    http(later ? [updated("51", epoch + 2000), updated("52", epoch + 1000), ...baseline] : baseline,
      { link: next, date: new Date(epoch).toUTCString() }) :
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

test("a failed continuation preserves the successful page's longer shared polling deadline", async t => {
  const f = await fixture(t);
  const watcher = f.make();
  f.response(args => args.at(-1).includes("page=1")
    ? http([thread()], { link: next, "x-poll-interval": "300" })
    : http({}, {}, 500));
  await watcher.check();
  assert.equal(f.calls.length, 2);
  assert.equal((await f.state()).watermark, null);
  assert.equal((await f.state()).nextPollAt, epoch + 300_000);
  const other = f.make();
  f.advance(299_999);
  await other.sync();
  assert.equal(other.snapshot().state, "error");
  assert.equal(f.calls.length, 2);
  f.response(undefined);
  f.advance(1);
  await other.check();
  assert.equal(f.calls.length, 3);
  assert.equal(other.snapshot().state, "watching");
  assert.deepEqual(f.deliveries, []);
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
  const module = new URL("../src/provider/desktop.mjs", import.meta.url).href;
  const settings = new URL("../src/provider/settings.mjs", import.meta.url).href;
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
      client: { clear() {}, blockedUntil: 0, serverBlockedUntil: 0, async page() {
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
