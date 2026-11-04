import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInContext } from "node:vm";
import { firstPage, GitHubClient, nextPage, POLL_MS } from "../src/github.mjs";
import { apiTarget } from "../src/model.mjs";
import { Inbox } from "../src/inbox.mjs";
import { Preferences } from "../src/settings.mjs";
import { startServer } from "../src/server.mjs";
import { http, thread } from "./fixtures.mjs";
import { renderer, settle } from "./renderer-fixtures.mjs";

function fixture(rows = [thread("1"), thread("2", { unread: false }), thread("3", { unread: false, done: true })]) {
  const calls = [];
  let now = 0;
  const client = new GitHubClient({
    now: () => now, sleep: async delay => { now += delay; },
    run: async args => {
      calls.push(args);
      const url = new URL(args.at(-1), "https://api.github.com");
      const method = args[args.indexOf("--method") + 1];
      if (method !== "GET") {
        const row = rows.find(row => url.pathname.endsWith(`/${row.id}`));
        assert.ok(row);
        row.unread = false;
        if (method === "DELETE") row.done = true;
        return `HTTP/2 ${method === "DELETE" ? 204 : 205} Synthetic\r\n\r\n`;
      }
      const selected = rows.filter(row => url.searchParams.get("all") === "false" ? row.unread :
        url.searchParams.get("is_done") !== "false" || !row.done);
      const page = Number(url.searchParams.get("page"));
      url.searchParams.set("page", String(page + 1));
      return http(selected.slice((page - 1) * 50, page * 50), {
        etag: '"synthetic"',
        ...(selected.length > page * 50 ? { link: `<${url.href}>; rel="next"` } : {}),
      });
    },
  });
  return { client, calls, rows, advance: () => { now += POLL_MS; } };
}

test("switching cached views after Done never skips a shifted pagination boundary", async t => {
  for (const switchMode of [false, true]) {
    for (const cachedSecondPage of [false, true]) {
      const { client } = fixture(Array.from({ length: 100 }, (_, index) => thread(String(index + 1))));
      const inbox = new Inbox(client);
      t.after(() => inbox.close());
      await inbox.refresh();
      if (cachedSecondPage) await inbox.more();
      await inbox.markDone({ id: "1" });
      if (switchMode) {
        await inbox.setFilters({ mode: "unread" });
        await inbox.setFilters({ mode: "inbox" });
      } else {
        inbox.setMatchGitHubInbox(false);
        await inbox.refresh();
        inbox.setMatchGitHubInbox(true);
        await inbox.refresh();
      }
      assert.equal(inbox.summary().loaded, 50);
      assert.equal(inbox.summary().needsRefresh, false);
      await inbox.more();
      assert.deepEqual(inbox.loadedItems().map(item => item.id),
        Array.from({ length: 99 }, (_, index) => String(index + 2)));
      assert.equal(inbox.summary().hasMore, false);
    }
  }
});

test("saved view changes do not reset explicit unread pagination or its polling deadline", async t => {
  const { client, calls } = fixture(Array.from({ length: 100 }, (_, index) => thread(String(index + 1))));
  const inbox = new Inbox(client, { mode: "unread" });
  t.after(() => inbox.close());
  await inbox.refresh();
  const deadline = inbox.nextRefreshAt;
  inbox.setMatchGitHubInbox(false);
  assert.equal(inbox.summary().needsRefresh, false);
  assert.equal(inbox.nextRefreshAt, deadline);
  await inbox.more();
  const count = calls.length;
  for (const value of [true, false]) {
    inbox.setMatchGitHubInbox(value);
    await inbox.refresh();
    assert.equal(inbox.summary().loaded, 100);
    assert.equal(inbox.summary().needsRefresh, false);
    assert.equal(inbox.nextRefreshAt, deadline);
    assert.equal(calls.length, count);
  }
});

test("a preference change during an explicit unread refresh keeps every loaded page", async t => {
  const { client, advance } = fixture(Array.from({ length: 100 }, (_, index) => thread(String(index + 1))));
  const inbox = new Inbox(client, { mode: "unread" });
  t.after(() => inbox.close());
  await inbox.refresh();
  await inbox.more();
  advance();
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const run = client.run;
  let started = false;
  client.run = async args => {
    if (!started) {
      started = true;
      enter();
      await held;
    }
    return run(args);
  };
  const refreshing = inbox.refresh();
  await entered;
  inbox.setMatchGitHubInbox(false);
  release();
  await refreshing;
  assert.equal(inbox.summary().loaded, 100);
  assert.equal(inbox.summary().needsRefresh, false);
  assert.ok(inbox.nextRefreshAt > client.now());
});

test("inbox matching and unread queries preserve their exact scope through pagination", async () => {
  assert.equal(firstPage(), "/notifications?all=false&per_page=50&page=1");
  assert.equal(firstPage({ mode: "inbox" }), "/notifications?all=true&is_done=false&per_page=50&page=1");
  assert.equal(firstPage({ mode: "inbox", matchGitHubInbox: true }), "/notifications?all=true&is_done=false&per_page=50&page=1");
  assert.equal(firstPage({ mode: "inbox", matchGitHubInbox: false }), firstPage());
  assert.equal(firstPage({ mode: "unread", matchGitHubInbox: true }), firstPage());
  for (const target of [apiTarget(), apiTarget("https://git.example.com/api/v3")]) {
    for (const options of [{}, { mode: "inbox" }, { mode: "inbox", matchGitHubInbox: false }]) {
      const first = firstPage(options);
      const url = new URL(`${target.baseUrl}${first}`);
      url.searchParams.set("page", "2");
      const link = () => `<${url.href}>; rel="next"`;
      assert.match(nextPage(link(), first, target), /page=2/);
      const expectedDone = url.searchParams.get("is_done");
      for (const done of [null, "false", "true", ""]) {
        if (done === expectedDone) continue;
        if (done === null) url.searchParams.delete("is_done");
        else url.searchParams.set("is_done", done);
        assert.throws(() => nextPage(link(), first, target), { code: "invalid_pagination" });
      }
    }
  }
  const { client, calls } = fixture();
  for (const query of ["all=true", "all=true&all=true", "all=false&is_done=false", "all=true&is_done=true",
    "all=true&is_done=false&is_done=false", "all=true&unknown=false"]) {
    assert.throws(() => client.page(`/notifications?${query}&per_page=50&page=1`), { code: "invalid_pagination" });
  }
  assert.equal(calls.length, 0);
});

test("read and Done confirmations update inbox and unread caches across both toggle states", async t => {
  const { client, calls } = fixture();
  const inbox = new Inbox(client);
  const unmatched = new Inbox(client);
  const unread = new Inbox(client, { mode: "unread" });
  unmatched.setMatchGitHubInbox(false);
  t.after(() => { inbox.close(); unmatched.close(); unread.close(); });
  await inbox.refresh();
  await unmatched.refresh();
  await unread.refresh();
  assert.deepEqual([inbox.summary().loaded, unmatched.summary().loaded, unread.summary().loaded], [2, 1, 1]);
  assert.equal(client.cache.size, 2);
  await inbox.markRead({ id: "1" });
  assert.deepEqual([inbox.summary().loaded, unmatched.summary().loaded, unread.summary().loaded], [2, 0, 0]);
  assert.equal(inbox.summary().unread, 0);
  await assert.rejects(inbox.markRead({ id: "1" }), { code: "unknown_thread" });
  await inbox.markDone({ id: "2" });
  assert.deepEqual([inbox.summary().loaded, unmatched.summary().loaded], [1, 0]);
  for (const panel of [inbox, unmatched, unread]) {
    assert.equal(panel.summary().needsRefresh, true);
    assert.doesNotMatch(JSON.stringify(panel.summary()), /Synthetic|example\/|selectionKey|title|"items"/);
  }
  for (const page of client.cache.values()) assert.equal(page.etag, undefined);
  assert.equal(calls.filter(args => args.includes("GET")).length, 2);
  assert.equal(calls.filter(args => args.includes("PATCH") || args.includes("DELETE")).length, 2);
});

test("Match GitHub Inbox switches atomically, resets pagination and keeps the previous view through failures", async t => {
  let now = 0;
  let fail = false;
  const calls = [];
  const client = new GitHubClient({ now: () => now, run: async args => {
    calls.push(args);
    const url = new URL(args.at(-1), "https://api.github.com");
    if (!url.searchParams.has("is_done")) return fail ? http({}, {}, 500) : http([thread("3")]);
    if (url.searchParams.get("page") === "2") return http([thread("2", { unread: false })]);
    url.searchParams.set("page", "2");
    return http([thread("1")], { link: `<${url.href}>; rel="next"` });
  } });
  const inbox = new Inbox(client, { query: "Synthetic", attention: "review_requested" });
  t.after(() => inbox.close());
  await inbox.refresh();
  await inbox.more();
  const before = inbox.snapshot();
  for (const value of [null, undefined, "true", 1]) assert.throws(() => inbox.setMatchGitHubInbox(value), { code: "invalid_settings" });
  inbox.setMatchGitHubInbox(false);
  await assert.rejects(inbox.more(), { code: "refresh_required" });
  fail = true;
  await assert.rejects(inbox.refresh(), { code: "github_http" });
  assert.equal(inbox.snapshot().matchGitHubInbox, true);
  assert.deepEqual(inbox.snapshot().groups, before.groups);
  assert.equal(inbox.snapshot().status, "stale");
  const count = calls.length;
  await assert.rejects(inbox.refresh(), { code: "github_http" });
  assert.equal(calls.length, count);
  fail = false;
  now = client.blockedUntil;
  await inbox.refresh();
  assert.equal(inbox.snapshot().matchGitHubInbox, false);
  assert.equal(inbox.pages.length, 1);
  assert.equal(inbox.summary().loaded, 1);
  assert.deepEqual(inbox.filters, before.filters);
  inbox.setMatchGitHubInbox(true);
  await inbox.refresh();
  assert.equal(inbox.snapshot().matchGitHubInbox, true);
  assert.equal(inbox.pages.length, 1);
  assert.equal(inbox.summary().hasMore, true);
});

test("a setting changed during a refresh is reconciled by the next refresh", async t => {
  let finish;
  const { client } = fixture();
  const run = client.run;
  client.run = async args => {
    await new Promise(resolve => { finish = resolve; });
    return run(args);
  };
  const inbox = new Inbox(client);
  t.after(() => inbox.close());
  const refreshing = inbox.refresh();
  await settle();
  inbox.setMatchGitHubInbox(false);
  finish();
  await refreshing;
  assert.equal(inbox.snapshot().matchGitHubInbox, true);
  assert.equal(inbox.summary().needsRefresh, true);
  assert.equal(inbox.nextRefreshAt, 0);
  client.run = run;
  await inbox.refresh();
  assert.equal(inbox.snapshot().matchGitHubInbox, false);
  assert.equal(inbox.summary().loaded, 1);
});

test("mixed-state batches select unread items for Read and all shown items for Done in every scope", async t => {
  for (const scope of ["repository", "date", "shown"]) {
    for (const action of ["read", "done"]) {
      const { client, calls } = fixture();
      const inbox = new Inbox(client);
      t.after(() => inbox.close());
      await inbox.refresh();
      const input = scope === "repository" ? {
        repository: "example/widgets", selectionKey: inbox.groups()[0].selectionKey,
      } : { scope, selectionKey: inbox.snapshot().selectionKey,
        ...(scope === "date" ? { date: "2026-01-10", timeZone: "UTC" } : {}) };
      inbox.batch.start({ ...input, action });
      assert.equal(inbox.batch.snapshot().total, action === "read" ? 1 : 2);
      await inbox.batch.done;
      assert.equal(calls.filter(args => args.includes(action === "read" ? "PATCH" : "DELETE")).length,
        action === "read" ? 1 : 2);
      assert.equal(inbox.summary().loaded, action === "read" ? 2 : 0);
      assert.equal(inbox.summary().unread, 0);
      if (action === "read") {
        const selection = scope === "repository" ? { repository: "example/widgets", selectionKey: inbox.groups()[0].selectionKey } :
          { ...input, selectionKey: inbox.snapshot().selectionKey };
        assert.throws(() => inbox.batch.start(selection), { code: "invalid_selection" });
      }
    }
  }
});

test("changing Match GitHub Inbox cannot widen or interrupt a running batch", async t => {
  const { client, calls } = fixture();
  const run = client.run;
  let finish;
  client.run = async args => {
    if (args.includes("DELETE")) await new Promise(resolve => { finish = resolve; });
    return run(args);
  };
  const inbox = new Inbox(client);
  t.after(() => inbox.close());
  await inbox.refresh();
  inbox.batch.start({ scope: "shown", selectionKey: inbox.snapshot().selectionKey, action: "done" });
  await settle();
  inbox.setMatchGitHubInbox(false);
  await assert.rejects(inbox.refresh(), { code: "busy" });
  const token = inbox.batch.snapshot().token;
  inbox.batch.cancel({ token });
  finish();
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().total, 2);
  assert.equal(inbox.batch.snapshot().succeeded, 1);
  assert.equal(inbox.batch.snapshot().notAttempted, 1);
  assert.equal(inbox.snapshot().matchGitHubInbox, true);
  client.run = run;
  await inbox.refresh();
  assert.equal(inbox.snapshot().matchGitHubInbox, false);
  assert.throws(() => inbox.batch.retry({ token }), { code: "no_remaining" });
  inbox.setMatchGitHubInbox(true);
  await inbox.refresh();
  inbox.batch.retry({ token });
  assert.equal(inbox.batch.snapshot().total, 1);
  await inbox.batch.done;
  assert.deepEqual(calls.filter(args => args.includes("DELETE")).map(args => args.at(-1)),
    ["/notifications/threads/1", "/notifications/threads/2"]);
  assert.equal(inbox.summary().loaded, 0);
});

test("older caches in other views cannot veto the latest selected read state", async t => {
  for (const action of ["read", "done"]) {
    const { client, rows, calls } = fixture();
    const older = new Inbox(client, { mode: action === "read" ? "inbox" : "unread" });
    const inbox = new Inbox(client, { mode: action === "read" ? "unread" : "inbox" });
    t.after(() => { older.close(); inbox.close(); });
    rows[0].unread = action !== "read";
    await older.refresh();
    rows[0].unread = action === "read";
    await inbox.refresh();
    inbox.batch.start({ scope: "shown", selectionKey: inbox.snapshot().selectionKey, action });
    await inbox.batch.done;
    assert.equal(inbox.batch.snapshot(), null);
    assert.equal(calls.filter(args => args.includes(action === "read" ? "PATCH" : "DELETE")).length,
      action === "read" ? 1 : 2);
  }
});

test("mode switches retain previous data on failure and reject changed or closed responses", async t => {
  for (const change of ["failure", "revision", "closed", "setting"]) {
    const { client } = fixture();
    const inbox = new Inbox(client);
    t.after(() => inbox.close());
    await inbox.refresh();
    const before = inbox.snapshot().groups;
    inbox.marking.add("1");
    await assert.rejects(inbox.setFilters({ mode: "unread" }), { code: "busy" });
    inbox.marking.clear();
    const run = client.run;
    client.run = async args => {
      if (change === "failure") return http({}, {}, 500);
      if (change === "revision") client.revision++;
      if (change === "closed") inbox.close();
      if (change === "setting") inbox.setMatchGitHubInbox(false);
      return run(args);
    };
    if (change === "setting") {
      await inbox.setFilters({ mode: "unread" });
      assert.equal(inbox.filters.mode, "unread");
      assert.ok(inbox.nextRefreshAt > client.now());
      assert.equal(inbox.summary().needsRefresh, false);
    } else {
      await assert.rejects(inbox.setFilters({ mode: "unread" }), {
        code: change === "failure" ? "github_http" : change === "closed" ? "closed" : "inbox_changed",
      });
      assert.equal(inbox.filters.mode, "inbox");
      assert.deepEqual(inbox.snapshot().groups, change === "closed" ? [] : before);
    }
  }
});

test("Match GitHub Inbox persists only a boolean, synchronizes panels, and never changes desktop preferences", async t => {
  const directory = await mkdtemp(join(tmpdir(), "match-github-inbox-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preferences = new Preferences({ directory });
  assert.equal((await preferences.read()).matchGitHubInbox, true);
  await preferences.update({ autoOpen: true, groupBy: "date" });
  const { client, calls } = fixture();
  const inbox = new Inbox(client);
  const other = new Inbox(client);
  const servers = await Promise.all([inbox, other].map(panel => startServer(panel, { preferences })));
  t.after(() => Promise.all(servers.map(server => server.close())));
  const request = async (server, path, body) => {
    const url = new URL(server.url);
    const response = await fetch(`${url.origin}/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  await request(servers[0], "refresh", {});
  const saved = await request(servers[0], "settings", { matchGitHubInbox: false });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.matchGitHubInbox, false);
  assert.equal(saved.data.desktopNotifications, false);
  const snapshot = await request(servers[1], "refresh", {});
  assert.equal(snapshot.data.matchGitHubInbox, false);
  assert.equal(snapshot.data.loaded, 1);
  assert.deepEqual(JSON.parse(await readFile(preferences.path, "utf8")), { autoOpen: true, groupBy: "date", matchGitHubInbox: false });
  assert.deepEqual(await readdir(directory), ["settings.json"]);
  assert.ok(calls.every(args => args.includes("GET")));
  for (const value of [null, 1, "true"]) {
    assert.equal((await request(servers[0], "settings", { matchGitHubInbox: value })).status, 400);
    assert.equal((await preferences.read()).matchGitHubInbox, false);
  }
  assert.equal((await new Preferences({ directory }).read()).matchGitHubInbox, false);
});

test("renderer preserves the saved view through the Show notifications dropdown without writes", async () => {
  const storedSettings = { groupBy: "none" };
  const ui = await renderer({ storedSettings, initialRows: [
    thread("1"), thread("2", { unread: false }), thread("3", { unread: false, done: true }),
  ] });
  const button = key => ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === key);
  assert.equal(ui.ids.get("count").textContent, "2 total \u00b7 1 unread");
  assert.equal(button("read:2"), undefined);
  assert.equal(button("done:2").disabled, false);
  assert.equal(button("bulk:shown").dataset.count, "1");
  assert.equal(button("bulk-done:shown").dataset.count, "2");
  const select = ui.ids.get("show-notifications");
  assert.equal(select.value, "all");
  select.value = "unread";
  select.events.change();
  await settle();
  assert.equal(storedSettings.matchGitHubInbox, false);
  assert.equal(select.value, "unread");
  assert.equal(ui.ids.get("count").textContent, "1 total \u00b7 1 unread");
  assert.equal(button("bulk-done:shown").dataset.count, "1");
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
  await runInContext('update("filters", { mode: "unread" })', ui.context);
  assert.equal(select.disabled, true);
  select.events.change();
  assert.equal(storedSettings.matchGitHubInbox, false);
  await runInContext('update("filters", { mode: "inbox" })', ui.context);
  assert.equal(select.disabled, false);
  assert.equal(ui.ids.get("count").textContent, "1 total \u00b7 1 unread");
  select.value = "all";
  select.events.change();
  await settle();
  assert.equal(ui.ids.get("count").textContent, "2 total \u00b7 1 unread");
  assert.equal(storedSettings.matchGitHubInbox, true);
  assert.equal(button("done:3"), undefined);
  await runInContext('update("filters", { mode: "unread" })', ui.context);
  assert.equal(select.value, "unread");
  assert.equal(select.disabled, true);
  assert.equal(storedSettings.matchGitHubInbox, true);
  await runInContext('update("filters", { mode: "inbox" })', ui.context);
  assert.equal(select.value, "all");
  ui.window.events.pagehide();
  ui.inbox.close();
});

test("Show notifications preserves an existing unread preference and restores it after failed saves", async t => {
  let fail = true;
  const storedSettings = { matchGitHubInbox: false, groupBy: "repo" };
  const ui = await renderer({ storedSettings, onSettings: input => {
    if (input && fail) throw new Error("Could not save notification settings.");
  } });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const select = ui.ids.get("show-notifications");
  assert.equal(select.value, "unread");
  assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
  select.value = "all";
  select.events.change();
  await settle();
  assert.equal(select.value, "unread");
  assert.equal(storedSettings.matchGitHubInbox, false);
  assert.equal(ui.ids.get("settings-error").hidden, false);
  fail = false;
  select.value = "all";
  select.events.change();
  await settle();
  assert.equal(select.value, "all");
  assert.equal(storedSettings.matchGitHubInbox, true);
  assert.equal(ui.ids.get("settings-error").hidden, true);
  assert.deepEqual(ui.calls.filter(call => call.path === "/api/settings" && call.options.body)
    .map(call => JSON.parse(call.options.body)), [{ matchGitHubInbox: true }, { matchGitHubInbox: true }]);
});
