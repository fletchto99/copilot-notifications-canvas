import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInContext } from "node:vm";
import { firstPage, GitHubClient, nextPage, POLL_MS } from "../src/provider/github.mjs";
import { apiTarget, InboxError } from "../src/shared/model.mjs";
import { Inbox } from "../src/provider/inbox.mjs";
import { Preferences } from "../src/provider/settings.mjs";
import { startServer } from "../src/provider/server.mjs";
import { http, retrySelection, thread } from "./fixtures.mjs";
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

test("full inbox and desktop unread queries preserve their exact scope through pagination", () => {
  assert.equal(firstPage(), "/notifications?all=false&per_page=50&page=1");
  assert.equal(firstPage({ mode: "inbox" }), "/notifications?all=true&is_done=false&per_page=50&page=1");
  for (const target of [apiTarget(), apiTarget("https://git.example.com/api/v3")]) {
    for (const mode of ["inbox", "unread"]) {
      const first = firstPage({ mode });
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

test("legacy preferences seed each panel once without writing settings or limiting fetched items", async t => {
  const directory = await mkdtemp(join(tmpdir(), "notification-read-filter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preferences = new Preferences({ directory });
  const saved = '{"matchGitHubInbox":false,"autoOpen":true,"futureSetting":"preserved"}\n';
  await writeFile(preferences.path, saved);
  const { client, calls } = fixture();
  for (const [input, expected] of [[{}, "unread"], [{ readState: "all" }, "all"], [{ readState: "read" }, "read"],
    [{ mode: "unread" }, "unread"], [{ mode: "inbox" }, "all"], [{ mode: "unread", readState: "read" }, "read"]]) {
    const inbox = new Inbox(client, input);
    t.after(() => inbox.close());
    await inbox.syncSettings(preferences);
    await inbox.refresh();
    assert.equal(inbox.filters.readState, expected);
    assert.equal(inbox.summary().loaded, 2);
    assert.equal(inbox.summary().matching, expected === "all" ? 2 : 1);
    await inbox.setFilters({ readState: "all" });
    const pages = inbox.pages;
    await inbox.syncSettings(preferences);
    assert.equal(inbox.filters.readState, "all");
    assert.equal(inbox.pages, pages);
  }
  assert.equal(calls.length, 1, "All panels share the full inbox cache");
  assert.match(calls[0].at(-1), /all=true&is_done=false/);
  assert.equal(await readFile(preferences.path, "utf8"), saved);
  assert.deepEqual(await readdir(directory), ["settings.json"]);
});

test("a late or recovered settings read cannot overwrite an explicitly selected read filter", async t => {
  for (const failure of [false, true]) {
    const inbox = new Inbox(fixture().client);
    t.after(() => inbox.close());
    if (failure) {
      await inbox.syncSettings({ read: async () => { throw new InboxError("settings_read", "Synthetic settings failure", 500); } });
      assert.equal(inbox.summary().settingsError.code, "settings_read");
    }
    let finish;
    const reading = inbox.syncSettings({ read: () => new Promise(resolve => { finish = resolve; }) });
    await inbox.setFilters({ readState: "read" });
    finish({ matchGitHubInbox: false });
    await reading;
    assert.equal(inbox.filters.readState, "read");
    assert.equal(inbox.summary().settingsError, null);
  }
});

test("initial inputs and recovered choices win until the shared filters change", async t => {
  const filterDefaults = { type: "PullRequest", readState: "unread", reason: "mention", age: "older_7d" };
  const settings = { read: async () => ({ matchGitHubInbox: false, filterDefaults }) };
  for (const input of [{}, { type: "Issue", readState: "all" }, { mode: "inbox", age: "all" }]) {
    const inbox = new Inbox(fixture().client, input);
    t.after(() => inbox.close());
    await inbox.syncSettings(settings);
    assert.equal(inbox.filters.type, input.type ?? filterDefaults.type);
    assert.equal(inbox.filters.readState, input.readState ?? (input.mode === "inbox" ? "all" : filterDefaults.readState));
    assert.equal(inbox.filters.age, input.age ?? filterDefaults.age);
    assert.equal(inbox.filters.reason, "mention");
    assert.equal(inbox.filters.query, "");
    assert.equal(inbox.filters.attention, "all");
    await inbox.syncSettings({ read: async () => ({ filterDefaults: { ...filterDefaults, type: "Release" } }) });
    assert.deepEqual(inbox.filters, { query: "", attention: "all", ...filterDefaults, type: "Release" });
  }
  const inbox = new Inbox(fixture().client);
  t.after(() => inbox.close());
  await inbox.syncSettings({ read: async () => { throw new InboxError("settings_read", "Synthetic settings failure", 500); } });
  await inbox.setFilters({ type: "Issue", age: "last_24h" });
  await inbox.syncSettings(settings);
  assert.deepEqual(inbox.filters, { query: "", attention: "all",
    type: "Issue", readState: "unread", reason: "mention", age: "last_24h" });
  await assert.rejects(inbox.syncSettings({ read: async () => ({ filterDefaults: {} }) }), { code: "invalid_settings" });
});

test("older reads, read failures and completed writes cannot restore stale shared filters", async t => {
  const inbox = new Inbox(fixture().client);
  t.after(() => inbox.close());
  const first = { revision: 1, filterDefaults: { type: "Issue", readState: "all", reason: "all", age: "all" } };
  inbox.applySettings(first);
  let release;
  const pending = inbox.syncSettings({ read: () => new Promise(resolve => { release = resolve; }) });
  const second = { revision: 2, filterDefaults: { ...first.filterDefaults, type: "Release" } };
  inbox.applySettings(second);
  release(first);
  assert.equal(await pending, undefined);
  assert.equal(inbox.filters.type, "Release");
  assert.equal(inbox.snapshot().settingsRevision, 2);
  const failing = inbox.syncSettings({ read: () => new Promise((resolve, reject) => {
    release = () => reject(new InboxError("settings_read", "Old read failed", 500));
  }) });
  inbox.applySettings({ ...second, revision: 3 });
  release();
  await failing;
  assert.equal(inbox.settingsError, null);
  const writing = inbox.syncFilters({ type: "PullRequest", query: "local" }, {
    updateFilters: () => new Promise(resolve => { release = resolve; }),
  });
  inbox.applySettings({ ...second, revision: 5 });
  release({ revision: 4, filterDefaults: { ...first.filterDefaults, type: "PullRequest" } });
  await writing;
  assert.equal(inbox.filters.type, "Release");
  assert.equal(inbox.filters.query, "local");
  assert.equal(inbox.snapshot().settingsRevision, 5);
  await assert.rejects(inbox.syncFilters({ type: "Issue" }), { code: "settings_unavailable" });
  await assert.rejects(inbox.syncFilters({ type: "Issue", query: 1 }, {
    updateFilters: () => assert.fail("Invalid local input must not write shared settings"),
  }), { code: "invalid_filters" });
  const overridden = new Inbox(fixture().client, { type: "Issue", query: "local" });
  t.after(() => overridden.close());
  const cleared = { revision: 1, filterDefaults: { type: "all", readState: "all", reason: "all", age: "all" } };
  overridden.applySettings(cleared);
  assert.equal(overridden.filters.type, "Issue");
  overridden.applySettings({ ...cleared, revision: 2 });
  assert.equal(overridden.filters.type, "all", "A shared clear also replaces an initial override when saved values were already clear");
  assert.equal(overridden.filters.query, "local");
});

test("HTTP filter patches sync active canvases, preserve local search and reject stale batches", async t => {
  const directory = await mkdtemp(join(tmpdir(), "notification-filter-defaults-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preferences = new Preferences({ directory });
  await preferences.update({ matchGitHubInbox: false });
  const { client, calls } = fixture();
  const panels = [new Inbox(client), new Inbox(client)];
  const servers = await Promise.all(panels.map(inbox => startServer(inbox, { preferences })));
  t.after(() => Promise.all(servers.map(server => server.close())));
  const request = async (server, path, body, status = 200) => {
    const url = new URL(server.url);
    const response = await fetch(`${url.origin}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, status);
    return response.json();
  };
  await Promise.all(servers.map(server => request(server, "refresh", {})));
  const old = panels[1].snapshot();
  await request(servers[0], "filters", { readState: "all", query: "notification 2", attention: "review_requested" });
  const rejected = await request(servers[1], "batch/start",
    { scope: "shown", selectionKey: old.selectionKey, action: "done" }, 409);
  assert.equal(rejected.error.code, "selection_changed");
  const filterDefaults = { type: "PullRequest", readState: "all", reason: "review_requested", age: "all" };
  await request(servers[1], "filters", { type: "PullRequest", reason: "review_requested" });
  for (const [index, server] of servers.entries()) {
    const state = await request(server, "state");
    assert.deepEqual(state.filters, { ...filterDefaults, query: index === 0 ? "notification 2" : "",
      attention: index === 0 ? "review_requested" : "all" });
    assert.equal(state.settingsRevision, 3);
  }
  const fresh = new Inbox(client);
  panels.push(fresh);
  const freshServer = await startServer(fresh, { preferences: new Preferences({ directory }) });
  servers.push(freshServer);
  const state = await request(freshServer, "refresh", {});
  assert.deepEqual(state.filters, { query: "", attention: "all", ...filterDefaults });
  assert.equal(state.matching, 2, "Saved All overrides the legacy unread-only default");
  assert.deepEqual((await preferences.document()).filterDefaults, filterDefaults);
  await request(servers[0], "filters", { type: "all", readState: "all", reason: "all", age: "all" });
  for (const server of servers) assert.equal((await request(server, "state")).filters.type, "all");
  assert.equal((await preferences.read()).matchGitHubInbox, false);
  assert.ok(calls.every(args => args.includes("GET")));
});

test("HTTP retries reject shared-filter changes before writing, across scopes and actions", async t => {
  for (const scope of ["repository", "date", "shown"]) {
    for (const action of ["read", "done"]) {
      const directory = await mkdtemp(join(tmpdir(), "notification-retry-selection-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const preferences = new Preferences({ directory });
      const { client, advance } = fixture([
        thread("1", { subject: { type: "Issue", title: "Synthetic issue", url: null } }), thread("2"),
      ]);
      const run = client.run;
      const writes = [];
      let fail = true;
      client.run = async (...args) => {
        if (args[0].includes("PATCH") || args[0].includes("DELETE")) {
          writes.push(args[0].at(-1));
          if (fail) return http({}, {}, 500);
        }
        return run(...args);
      };
      const inbox = new Inbox(client);
      const server = await startServer(inbox, { preferences });
      t.after(() => server.close());
      const url = new URL(server.url);
      const request = async (path, body, status = 200) => {
        const response = await fetch(`${url.origin}/api/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        assert.equal(response.status, status);
        return response.json();
      };
      const initial = await request("refresh", {});
      const selection = scope === "repository" ? {
        repository: initial.groups[0].repository, selectionKey: initial.groups[0].selectionKey,
      } : { scope, selectionKey: initial.selectionKey,
        ...(scope === "date" ? { date: "2026-01-10", timeZone: "UTC" } : {}) };
      await request("batch/start", { ...selection, action }, 202);
      await inbox.batch.done;
      await preferences.updateFilters({ type: "Issue" });
      const filtered = await request("state");
      assert.deepEqual(filtered.batch.retryableThreadIds, ["1"]);
      const retry = { token: filtered.batch.token, selectionKey: filtered.batch.retrySelectionKey };
      assert.doesNotMatch(JSON.stringify(inbox.summary()), /retrySelectionKey/);
      fail = false;
      advance();
      advance();
      await preferences.updateFilters({ type: "all" });
      const before = [...writes];
      assert.equal((await request("batch/retry", retry, 409)).error.code, "selection_changed");
      assert.deepEqual(writes, before);
      assert.equal(inbox.batch.snapshot().token, retry.token);
      await preferences.updateFilters({ type: "Issue" });
      const reviewed = await request("state");
      await request("batch/retry", { token: reviewed.batch.token, selectionKey: reviewed.batch.retrySelectionKey }, 202);
      await inbox.batch.done;
      assert.deepEqual(writes.slice(before.length), ["/notifications/threads/1"]);
      assert.equal(inbox.loadedItems().find(item => item.id === "2").unread, true);
    }
  }
});

test("filters and legacy mode aliases keep pagination, cached data and polling deadlines unchanged", async t => {
  const { client, calls } = fixture(Array.from({ length: 100 }, (_, index) =>
    thread(String(index + 1), { unread: index % 2 === 0 })));
  const inbox = new Inbox(client);
  t.after(() => inbox.close());
  inbox.applySettings({ matchGitHubInbox: false });
  await inbox.refresh();
  await inbox.more();
  const pages = inbox.pages;
  const deadline = inbox.nextRefreshAt;
  for (const input of [{ readState: "read" }, { mode: "inbox" }, { mode: "unread" }, { readState: "all" }]) {
    await inbox.setFilters(input);
    inbox.applySettings({ matchGitHubInbox: false });
    assert.equal(inbox.pages, pages);
    assert.equal(inbox.summary().loaded, 100);
    assert.equal(inbox.summary().matching, inbox.filters.readState === "all" ? 100 : 50);
    assert.equal(inbox.nextRefreshAt, deadline);
    assert.equal(inbox.summary().needsRefresh, false);
    assert.equal(calls.length, 2);
  }
});

test("changing read state after Done does not bypass page reconciliation or skip a shifted boundary", async t => {
  for (const cachedSecondPage of [false, true]) {
    const { client } = fixture(Array.from({ length: 100 }, (_, index) => thread(String(index + 1))));
    const inbox = new Inbox(client);
    t.after(() => inbox.close());
    await inbox.refresh();
    if (cachedSecondPage) await inbox.more();
    inbox.queueThread({ id: "1" }, "done");
    await inbox.batch.done;
    await inbox.setFilters({ readState: "unread" });
    await inbox.setFilters({ readState: "all" });
    assert.equal(inbox.summary().needsRefresh, true);
    await assert.rejects(inbox.more(), { code: "refresh_required" });
    await inbox.refresh({ force: true });
    if (inbox.summary().hasMore) await inbox.more();
    assert.deepEqual(inbox.loadedItems().map(item => item.id),
      Array.from({ length: 99 }, (_, index) => String(index + 2)));
    assert.equal(inbox.summary().hasMore, false);
  }
});

test("read and Done confirmations synchronize full inbox panels and the desktop unread cache", async t => {
  const { client, calls } = fixture();
  const inbox = new Inbox(client);
  const unread = new Inbox(client, { readState: "unread" });
  t.after(() => { inbox.close(); unread.close(); });
  await inbox.refresh();
  await unread.refresh();
  await client.page(firstPage());
  assert.equal(client.cache.size, 2);
  assert.equal(unread.summary().loaded, 2);
  assert.equal(unread.summary().matching, 1);
  inbox.queueThread({ id: "1" }, "read");
  await inbox.batch.done;
  assert.equal(inbox.summary().loaded, 2);
  assert.equal(unread.summary().loaded, 2);
  assert.equal(unread.summary().matching, 0);
  assert.throws(() => inbox.queueThread({ id: "1" }, "read"), { code: "unknown_thread" });
  inbox.queueThread({ id: "2" }, "done");
  await inbox.batch.done;
  for (const panel of [inbox, unread]) {
    assert.equal(panel.summary().loaded, 1);
    assert.equal(panel.summary().needsRefresh, true);
    assert.doesNotMatch(JSON.stringify(panel.summary()), /Synthetic|example\/|selectionKey|title|"items"/);
  }
  for (const page of client.cache.values()) assert.equal(page.etag, undefined);
  assert.equal(calls.filter(args => args.includes("GET")).length, 2);
  assert.equal(calls.filter(args => args.includes("PATCH") || args.includes("DELETE")).length, 2);
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
    }
  }
});

test("changing read state cannot widen or interrupt a running batch and retries stay scoped", async t => {
  const directory = await mkdtemp(join(tmpdir(), "notification-running-filter-sync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preferences = new Preferences({ directory });
  const { client, calls, advance } = fixture();
  const run = client.run;
  const finishes = [];
  client.run = async args => {
    if (args.includes("DELETE")) {
      await new Promise(resolve => { finishes.push(resolve); });
      if (args.at(-1).endsWith("/2")) {
        calls.push(args);
        return http({}, {}, 500);
      }
    }
    return run(args);
  };
  const inbox = new Inbox(client);
  t.after(() => inbox.close());
  await inbox.syncSettings(preferences);
  await inbox.refresh();
  inbox.batch.start({ scope: "shown", selectionKey: inbox.snapshot().selectionKey, action: "done" });
  await settle();
  await preferences.updateFilters({ readState: "unread" });
  await inbox.syncSettings(preferences);
  const token = inbox.batch.snapshot().token;
  finishes.forEach(finish => finish());
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().total, 2);
  assert.equal(inbox.batch.snapshot().succeeded, 1);
  assert.equal(inbox.batch.snapshot().failed, 1);
  client.run = run;
  advance();
  advance();
  assert.throws(() => inbox.batch.retry(retrySelection(inbox, { token })), { code: "no_remaining" });
  await preferences.updateFilters({ readState: "all" });
  await inbox.syncSettings(preferences);
  inbox.batch.retry(retrySelection(inbox, { token }));
  assert.equal(inbox.batch.snapshot().total, 1);
  await inbox.batch.done;
  assert.deepEqual(calls.filter(args => args.includes("DELETE")).map(args => args.at(-1)).sort(),
    ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/2"]);
  assert.equal(inbox.summary().loaded, 0);
});

test("older unread caches cannot veto the latest selected read state", async t => {
  for (const action of ["read", "done"]) {
    const { client, rows, calls } = fixture();
    const inbox = new Inbox(client);
    t.after(() => inbox.close());
    rows[0].unread = action !== "read";
    await client.page(firstPage());
    rows[0].unread = action === "read";
    await inbox.refresh();
    inbox.batch.start({ scope: "shown", selectionKey: inbox.snapshot().selectionKey, action });
    await inbox.batch.done;
    assert.equal(inbox.batch.snapshot(), null);
    assert.equal(calls.filter(args => args.includes(action === "read" ? "PATCH" : "DELETE")).length,
      action === "read" ? 1 : 2);
  }
});

test("a queued row action retains its target when the display filter changes", async t => {
  for (const action of ["read", "done"]) {
    const { client } = fixture();
    const run = client.run;
    let finish;
    const held = new Promise(resolve => { finish = resolve; });
    client.run = async args => {
      if (!args.includes("GET")) await held;
      return run(args);
    };
    const inbox = new Inbox(client);
    t.after(() => { finish(); inbox.close(); });
    await inbox.refresh();
    inbox.queueThread({ id: "1" }, action);
    await inbox.setFilters({ mode: "unread" });
    assert.equal(inbox.filters.readState, "unread");
    finish();
    await inbox.batch.done;
    assert.equal(inbox.summary().matching, 0);
    await inbox.setFilters({ readState: "all" });
    assert.equal(inbox.summary().matching, action === "read" ? 2 : 1);
  }
});

test("HTTP panels seed legacy preferences, then synchronize read-state changes without enabling alerts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "notification-read-filter-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preferences = new Preferences({ directory });
  await preferences.update({ matchGitHubInbox: false, autoOpen: true });
  const { client, calls } = fixture();
  const servers = await Promise.all([new Inbox(client), new Inbox(client)].map(inbox => startServer(inbox, { preferences })));
  t.after(() => Promise.all(servers.map(server => server.close())));
  const request = async (server, path, body) => {
    const url = new URL(server.url);
    const response = await fetch(`${url.origin}/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const server of servers) {
    const state = await request(server, "refresh", {});
    assert.equal(state.filters.readState, "unread");
    assert.equal(state.loaded, 2);
    assert.equal(state.matching, 1);
  }
  assert.equal((await request(servers[0], "filters", { readState: "all" })).matching, 2);
  assert.equal((await request(servers[0], "state")).filters.readState, "all");
  assert.equal((await request(servers[1], "state")).filters.readState, "all");
  assert.equal((await preferences.read()).matchGitHubInbox, false);
  assert.equal((await preferences.read()).filterDefaults.readState, "all");
  assert.equal((await preferences.read()).desktopNotifications, false);
  assert.ok(calls.every(args => args.includes("GET")));
});

test("renderer offers only Read state and keeps legacy preferences unchanged when it is cleared", async t => {
  const storedSettings = { matchGitHubInbox: false, groupBy: "none" };
  const ui = await renderer({ storedSettings, initialRows: [
    thread("1"), thread("2", { unread: false }), thread("3", { unread: false, done: true }),
  ] });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  assert.equal(ui.ids.has("show-notifications"), false);
  assert.equal(ui.ids.has("inbox-mode"), false);
  assert.equal(ui.ids.get("filter-readState").value, "unread");
  assert.equal(ui.ids.get("count").textContent, "2 loaded \u00b7 1 unread \u00b7 1 matching");
  assert.equal(ui.ids.get("filters-toggle").textContent, "Filters (1)");
  await ui.ids.get("filters-reset").events.click();
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("filter-readState").value, "all");
  assert.equal(ui.ids.get("count").textContent, "2 loaded \u00b7 1 unread");
  const select = ui.ids.get("filter-readState");
  select.value = "read";
  await select.events.change();
  assert.deepEqual(ui.ids.get("groups").querySelectorAll(".row-link").map(node => node.dataset.threadId), ["2"]);
  assert.equal(storedSettings.matchGitHubInbox, false);
  assert.equal(storedSettings.groupBy, "none");
  assert.equal(storedSettings.filterDefaults.readState, "read");
  assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});
