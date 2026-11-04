import test from "node:test";
import assert from "node:assert/strict";
import { firstPage, GitHubClient, POLL_MS } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { InboxError } from "../src/model.mjs";
import { http, inboxNext as next, thread } from "./fixtures.mjs";

test("settings-read failures preserve the requested view and surface an independent warning", async t => {
  const inbox = new Inbox(new GitHubClient({ run: async () => http([thread()]) }));
  t.after(() => inbox.close());
  const unavailable = new InboxError("settings_read", "Saved settings are unavailable.", 500);
  const failing = { read: async () => { throw unavailable; } };
  await inbox.syncSettings(failing);
  assert.equal(inbox.requestedMatchGitHubInbox, true);
  await inbox.refresh();
  assert.equal(inbox.summary().status, "ready");
  assert.equal(inbox.summary().settingsError.code, "settings_read");
  await inbox.syncSettings({ read: async () => ({ matchGitHubInbox: false }) });
  await inbox.refresh();
  const deadline = inbox.nextRefreshAt;
  await inbox.syncSettings(failing);
  assert.equal(inbox.requestedMatchGitHubInbox, false);
  assert.equal(inbox.matchGitHubInbox, false);
  assert.equal(inbox.nextRefreshAt, deadline);
  assert.deepEqual(inbox.summary().settingsError, { code: "settings_read", message: unavailable.message });
  assert.equal(inbox.summary().error, null);
  const unexpected = new Error("Unexpected preferences failure");
  await assert.rejects(inbox.syncSettings({ read: async () => { throw unexpected; } }), error => error === unexpected);
  await assert.rejects(inbox.syncSettings({ read: async () => ({ matchGitHubInbox: "all" }) }), { code: "invalid_settings" });
  await inbox.syncSettings({ read: async () => ({ matchGitHubInbox: false }) });
  assert.equal(inbox.summary().settingsError, null);
});

test("a 304 response cannot validate pagination invalidated by a confirmed write", async t => {
  let written = false;
  const client = new GitHubClient({ run: async args => {
    if (args.includes("DELETE")) {
      written = true;
      return "HTTP/2 204 Synthetic\r\n\r\n";
    }
    if (args.at(-1).includes("page=2")) return written
      ? http(null, { etag: '"still-old"', "last-modified": "Sat, 10 Jan 2026 12:00:00 GMT" }, 304)
      : http([thread("3")]);
    return http(written ? [thread("2")] : [thread("1"), thread("2")], { link: next });
  } });
  const inbox = new Inbox(client);
  t.after(() => inbox.close());
  await inbox.refresh();
  await client.page(inbox.pages[0].next);
  await inbox.markDone({ id: "1" });
  await inbox.refresh({ force: true });
  assert.equal(inbox.summary().needsRefresh, false);
  await assert.rejects(inbox.more(), { code: "refresh_required" });
  assert.deepEqual(inbox.loadedItems().map(item => item.id), ["2"]);
  assert.equal(inbox.summary().needsRefresh, true);
  const invalidated = [...client.cache.values()].find(page => page.invalidated);
  assert.equal(invalidated.etag, undefined);
  assert.equal(invalidated.modified, undefined);
});

test("regrouping restores API positions across repositories without exposing positions in summaries", async t => {
  const inbox = new Inbox(new GitHubClient({ run: async () => http([
    thread("9", { updated_at: "2026-01-12T10:00:00Z" }),
    thread("2", { repository: { full_name: "example/other" }, updated_at: "2026-01-12T14:00:00Z" }),
    thread("1", { updated_at: "2026-01-12T18:00:00Z" }),
  ]) }));
  t.after(() => inbox.close());
  await inbox.refresh();
  assert.deepEqual(inbox.groups().flatMap(group => group.items.map(item => item.apiPosition)), [0, 2, 1]);
  assert.deepEqual(inbox.shownSelection().items.map(item => item.id), ["9", "2", "1"]);
  assert.deepEqual(inbox.dateSelection("2026-01-12", "UTC").items.map(item => item.id), ["9", "2", "1"]);
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /apiPosition|example\/|Synthetic notification/);
});

test("repository order follows the loaded API sequence in both inbox and unread-only views", async t => {
  const rows = [
    thread("1", { repository: { full_name: "example/zulu" }, unread: false, updated_at: "2026-01-30T00:00:00Z" }),
    thread("2", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-20T00:00:00Z" }),
    thread("3", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-10T00:00:00Z" }),
  ];
  for (const matchGitHubInbox of [true, false]) {
    const inbox = new Inbox(new GitHubClient({ run: async args =>
      http(args.at(-1).includes("all=false") ? rows.filter(row => row.unread) : rows) }));
    t.after(() => inbox.close());
    inbox.setMatchGitHubInbox(matchGitHubInbox);
    await inbox.refresh();
    assert.deepEqual(inbox.groups().map(group => group.repository), matchGitHubInbox
      ? ["example/zulu", "example/alpha"] : ["example/alpha", "example/zulu"]);
  }
});

test("pagination and refresh preserve API rank even when update timestamps and duplicate pages disagree", async t => {
  for (const matchGitHubInbox of [true, false]) {
    const inbox = new Inbox(new GitHubClient({ run: async args => {
      const url = new URL(args.at(-1), "https://api.github.com");
      if (url.searchParams.get("page") === "2") return http([
        thread("9", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-20T00:00:00Z" }),
        thread("1", { repository: { full_name: "example/beta" }, updated_at: "2026-01-30T00:00:00Z" }),
      ]);
      url.searchParams.set("page", "2");
      return http([
        thread("9", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-10T00:00:00Z" }),
        thread("2", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-30T00:00:00Z" }),
      ], { link: `<${url.href}>; rel="next"` });
    } }));
    t.after(() => inbox.close());
    inbox.setMatchGitHubInbox(matchGitHubInbox);
    await inbox.refresh();
    await inbox.more();
    for (const force of [false, true]) {
      await inbox.refresh({ force });
      assert.deepEqual(inbox.loadedItems().map(item => item.id), ["9", "2", "1"]);
      assert.deepEqual(inbox.groups().map(group => group.repository), ["example/zulu", "example/alpha", "example/beta"]);
      assert.equal(inbox.loadedItems()[0].updatedAt, "2026-01-20T00:00:00.000Z");
    }
  }
});

test("load-more preserves visible coverage, deduplicates boundary shifts, and refresh reconciles loaded pages", async () => {
  let now = 0;
  let calls = 0;
  const client = new GitHubClient({ now: () => now, run: async args => {
    calls++;
    return args.at(-1).includes("page=1") ?
      http([thread("1"), thread("2")], { link: next }) : http([thread("2"), thread("3")]);
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 2);
  assert.equal(inbox.summary().hasMore, true);
  await inbox.more();
  assert.equal(inbox.summary().loaded, 3);
  assert.equal(inbox.summary().hasMore, false);
  now = 59_999;
  await inbox.refresh();
  assert.equal(calls, 2);
  now = 60_000;
  await inbox.refresh();
  assert.equal(calls, 4);
  assert.equal(inbox.summary().loaded, 3);
  assert.equal(inbox.summary().status, "ready");
});

test("overlapping pages keep first API positions but take duplicate state from the newest response", async t => {
  for (const freshPage of [1, 2]) {
    for (const unread of [false, true]) {
      let fresh = false;
      const writes = [];
      const client = new GitHubClient({ now: () => 1_000_000, run: async args => {
        if (args.includes("PATCH") || args.includes("DELETE")) {
          writes.push(args.at(-1));
          return `HTTP/2 ${args.includes("PATCH") ? 205 : 204} Synthetic\r\n\r\n`;
        }
        const page = Number(new URL(args.at(-1), "https://api.github.com").searchParams.get("page"));
        const duplicate = thread("9", {
          unread: fresh ? unread : !unread,
          subject: { title: fresh ? "Current duplicate" : "Older duplicate", type: "Issue", url: null },
        });
        return page === 1 ? http([duplicate, thread("2"), thread("1")], { link: next })
          : http([duplicate, thread("3")]);
      } });
      const inbox = new Inbox(client);
      t.after(() => inbox.close());
      const first = firstPage({ mode: "inbox" });
      await client.page(freshPage === 1 ? first.replace("page=1", "page=2") : first);
      fresh = true;
      await inbox.refresh();
      await inbox.more();
      assert.equal(inbox.pages[freshPage - 1].sequence, 2);
      assert.deepEqual(inbox.loadedItems().map(item => item.id), ["9", "2", "1", "3"]);
      const duplicate = inbox.loadedItems()[0];
      assert.equal(duplicate.title, "Current duplicate");
      assert.equal(duplicate.unread, unread);
      assert.equal(Object.hasOwn(duplicate, "sequence"), false);
      assert.equal(inbox.summary().unread, 3 + Number(unread));
      await inbox.setFilters({ query: "Current duplicate" });
      assert.equal(inbox.snapshot().matching, 1);
      inbox.batch.start({ scope: "shown", selectionKey: inbox.snapshot().selectionKey, action: unread ? "read" : "done" });
      await inbox.batch.done;
      assert.equal(inbox.batch.snapshot(), null);
      assert.deepEqual(writes, ["/notifications/threads/9"]);
    }
  }
});

test("duplicates within one response still use the newest notification timestamp", async t => {
  const inbox = new Inbox(new GitHubClient({ run: async () => http([
    thread("9", { updated_at: "2026-01-10T12:00:00Z", unread: true }),
    thread("2"),
    thread("9", { updated_at: "2026-01-10T13:00:00Z", unread: false }),
    thread("9", { updated_at: "2026-01-10T12:30:00Z", unread: true }),
  ]) }));
  t.after(() => inbox.close());
  await inbox.refresh();
  assert.deepEqual(inbox.loadedItems().map(item => item.id), ["9", "2"]);
  assert.equal(inbox.loadedItems()[0], inbox.pages[0].items[2]);
  assert.equal(inbox.summary().unread, 1);
});

test("search is local, unread mode excludes read items, and summaries never contain personal content", async () => {
  let calls = 0;
  const client = new GitHubClient({ run: async () => {
    calls++;
    return http([thread(), thread("2", { unread: false })]);
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 2);
  assert.equal(inbox.summary().unread, 1);
  await inbox.setFilters({ query: "widgets" });
  assert.equal(calls, 1);
  assert.equal(inbox.summary().searchActive, true);
  await inbox.setFilters({ mode: "unread" });
  assert.equal(calls, 2);
  assert.equal(inbox.summary().loaded, 1);
  assert.equal(inbox.summary().unread, 1);
  const summary = JSON.stringify(inbox.summary());
  assert.equal(summary.includes("widgets"), false);
  assert.equal(summary.includes("Synthetic"), false);
  assert.equal(summary.includes("https:"), false);
  assert.equal(Object.hasOwn(inbox.snapshot(), "activity"), false);
  assert.equal(Object.hasOwn(inbox.summary(), "activity"), false);
  assert.equal(Object.hasOwn(inbox, "seenActivity"), false);
  assert.equal(Object.hasOwn(inbox, "activityWatermark"), false);
});

test("each snapshot loads items once and observes subsequent changes", async t => {
  const inbox = new Inbox(new GitHubClient({ run: async () => http([thread()]) }));
  t.after(() => inbox.close());
  await inbox.refresh();
  const loadedItems = t.mock.method(inbox, "loadedItems");
  const snapshot = inbox.snapshot();
  assert.equal(loadedItems.mock.callCount(), 1);
  assert.equal(snapshot.loaded, 1);
  assert.equal(snapshot.matching, 1);
  assert.deepEqual(snapshot.groups, inbox.groups());

  loadedItems.mock.resetCalls();
  inbox.onThreadUpdated("1");
  const updated = inbox.snapshot();
  assert.equal(loadedItems.mock.callCount(), 1);
  assert.equal(updated.loaded, 0);
  assert.equal(updated.matching, 0);
  assert.deepEqual(updated.groups, []);
});

test("attention is panel-local, survives pagination and refresh, and returns only aggregate metadata", async t => {
  let calls = 0;
  const client = new GitHubClient({ run: async args => {
    calls++;
    return args.at(-1).includes("page=1") ?
      http([thread("1", { reason: "review_requested" }), thread("2", { reason: "mention" })], { link: next }) :
      http([thread("3", { reason: "review_requested" })]);
  } });
  const inbox = new Inbox(client);
  const other = new Inbox(client);
  t.after(() => { inbox.close(); other.close(); });
  assert.equal(inbox.filters.attention, "all");
  await inbox.refresh();
  const filtered = await inbox.setFilters({ attention: "review_requested" });
  assert.equal(calls, 1);
  assert.equal(filtered.loaded, 2);
  assert.equal(filtered.matching, 1);
  assert.equal(filtered.attention, "review_requested");
  assert.deepEqual(filtered.attentionCounts, { all: 2, review_requested: 1, mentioned: 1, team_mentioned: 0, assigned: 0, participating: 2 });
  assert.doesNotMatch(JSON.stringify(filtered), /Synthetic|example\/|selectionKey|"groups"|"filters"/);
  assert.equal(other.filters.attention, "all");
  await inbox.more();
  assert.equal(inbox.summary().matching, 2);
  assert.equal(inbox.summary().attentionCounts.review_requested, 2);
  assert.equal(inbox.summary().attentionCounts.all, 3);
  await inbox.setFilters({ query: "notification 3" });
  await inbox.refresh({ force: true });
  assert.equal(inbox.summary().matching, 1);
  assert.equal(inbox.summary().loaded, 3);
  assert.deepEqual(inbox.summary().attentionCounts, { all: 3, review_requested: 2, mentioned: 1, team_mentioned: 0, assigned: 0, participating: 3 });
  assert.deepEqual(inbox.filters, { mode: "inbox", query: "notification 3", attention: "review_requested" });
  await assert.rejects(inbox.setFilters({ attention: "bad" }), { code: "invalid_filters" });
  assert.equal(inbox.filters.attention, "review_requested");
  await inbox.setFilters({ attention: "all" });
  assert.equal(inbox.filters.query, "notification 3");
  await inbox.setFilters({ query: "no matching title" });
  assert.equal(inbox.summary().matching, 0);
  assert.deepEqual(inbox.summary().attentionCounts, { all: 3, review_requested: 2, mentioned: 1, team_mentioned: 0, assigned: 0, participating: 3 });
  const prefiltered = new Inbox(client, { attention: "mentioned" });
  t.after(() => prefiltered.close());
  await prefiltered.refresh();
  assert.equal(prefiltered.summary().matching, 1);
});

test("tab counts follow cross-panel reads and retain loaded data after a failed refresh", async t => {
  let fail = false;
  const client = new GitHubClient({ run: async args => {
    if (args.includes("PATCH")) return "HTTP/2 205 Reset Content\r\n\r\n";
    return fail ? http({}, {}, 500) : http([thread("1", { reason: "mention" }), thread("2", { reason: "assign" })]);
  } });
  const inbox = new Inbox(client, { attention: "mentioned" });
  const other = new Inbox(client);
  t.after(() => { inbox.close(); other.close(); });
  await inbox.refresh();
  await other.refresh();
  await other.markRead({ id: "1" });
  assert.deepEqual(inbox.snapshot().attentionCounts, { all: 2, review_requested: 0, mentioned: 1, team_mentioned: 0, assigned: 1, participating: 2 });
  assert.equal(inbox.summary().unread, 1);
  fail = true;
  await assert.rejects(inbox.refresh({ force: true }), { code: "github_http" });
  assert.equal(inbox.summary().status, "stale");
  assert.deepEqual(inbox.snapshot().attentionCounts, { all: 2, review_requested: 0, mentioned: 1, team_mentioned: 0, assigned: 1, participating: 2 });
});

test("forced refresh rechecks every loaded page before the next poll without losing search", async () => {
  let now = 1000;
  const calls = [];
  const client = new GitHubClient({ now: () => now, run: async args => {
    calls.push(args);
    return args.at(-1).includes("page=1") ? http([thread("1")], { link: next }) : http([thread("2")]);
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  await inbox.more();
  await inbox.setFilters({ query: "notification 2" });
  now += 1000;
  await inbox.refresh();
  assert.equal(calls.length, 2);
  await inbox.refresh({ force: true });
  assert.equal(calls.length, 4);
  assert.match(calls[2].at(-1), /page=1/);
  assert.match(calls[3].at(-1), /page=2/);
  assert.equal(inbox.summary().loaded, 2);
  assert.equal(inbox.summary().matching, 1);
  assert.equal(inbox.summary().lastFetchedAt, now);
  assert.equal(inbox.summary().nextRefreshAt, now + 60_000);
  await inbox.refresh({ force: false });
  assert.equal(calls.length, 4);
});

test("forced refresh validates options and keeps the old inbox if a later page fails", async () => {
  let fail = false;
  const client = new GitHubClient({ now: () => 1000, run: async args => {
    if (args.at(-1).includes("page=1")) return http([thread(fail ? "3" : "1")], { link: next });
    return fail ? http({}, {}, 500) : http([thread("2")]);
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  await inbox.more();
  const before = inbox.snapshot().groups;
  for (const input of [null, [], true, { force: "true" }, { force: null }, { force: true, unknown: true }]) {
    await assert.rejects(inbox.refresh(input), { code: "invalid_input" });
  }
  fail = true;
  await assert.rejects(inbox.refresh({ force: true }), { code: "github_http" });
  assert.deepEqual(inbox.snapshot().groups, before);
  assert.equal(inbox.summary().status, "stale");
});

test("a failed refresh is atomic, stale is honest, and local search cannot erase a fetch error", async () => {
  let now = 0;
  let fail = false;
  const client = new GitHubClient({ now: () => now, run: async args => {
    if (fail && args.at(-1).includes("page=2")) return http({}, {}, 500);
    return http([thread(args.at(-1).includes("page=1") ? "1" : "2")],
      args.at(-1).includes("page=1") ? { link: next } : {});
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  await inbox.more();
  const before = inbox.snapshot().groups;
  fail = true;
  now = POLL_MS;
  await assert.rejects(inbox.refresh(), { code: "github_http" });
  assert.deepEqual(inbox.snapshot().groups, before);
  assert.equal(inbox.summary().status, "stale");
  await inbox.setFilters({ query: "Synthetic" });
  assert.equal(inbox.summary().status, "stale");
  assert.equal(inbox.summary().error.code, "github_http");
  await assert.rejects(inbox.refresh(), { code: "github_http" });
});

test("initial errors and cross-panel rate blocks are never reported as a successful empty inbox", async () => {
  const client = new GitHubClient({ now: () => 0, run: async () => http({}, {}, 401) });
  await assert.rejects(new Inbox(client).refresh(), { code: "authentication" });
  const other = new Inbox(client);
  await assert.rejects(other.refresh(), { code: "authentication" });
  assert.equal(other.summary().status, "error");
  assert.equal(other.summary().lastFetchedAt, null);
});

test("All mode is rejected without changing the existing unread inbox", async () => {
  const client = new GitHubClient({ run: async () => http([thread()]) });
  assert.throws(() => new Inbox(client, { mode: "all" }), { code: "invalid_filters" });
  const inbox = new Inbox(client, { mode: "unread" });
  await inbox.refresh();
  await assert.rejects(inbox.setFilters({ mode: "all" }), { code: "invalid_filters" });
  assert.equal(inbox.summary().mode, "unread");
  assert.equal(inbox.summary().loaded, 1);
  assert.equal(inbox.summary().status, "ready");
});

test("concurrent actions fail explicitly and closing aborts outstanding gh work", async () => {
  let launched;
  const started = new Promise(resolve => { launched = resolve; });
  const client = new GitHubClient({ run: async (_args, { signal }) => {
    launched();
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    const { InboxError } = await import("../src/model.mjs");
    throw new InboxError("closed", "Closed.", 410);
  } });
  const inbox = new Inbox(client);
  const refresh = inbox.refresh();
  await started;
  await assert.rejects(inbox.refresh(), { code: "busy" });
  await assert.rejects(inbox.refresh({ force: true }), { code: "busy" });
  await assert.rejects(inbox.setFilters({ query: "widgets" }), { code: "busy" });
  inbox.close();
  await assert.rejects(refresh, { code: "closed" });
  await assert.rejects(inbox.more(), { code: "closed" });
  assert.equal(inbox.summary().loaded, 0);
});

test("closed inbox actions reject without queuing requests or restoring loaded rows", async () => {
  const calls = [];
  const client = new GitHubClient({ run: async args => {
    calls.push(args);
    return http([thread()], { link: next });
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  inbox.close();
  for (const action of [
    () => inbox.refresh(),
    () => inbox.refresh({ force: true }),
    () => inbox.more(),
    () => inbox.setFilters({ query: "widgets" }),
    () => inbox.markRead({ id: "1" }),
    () => inbox.markDone({ id: "1" }),
  ]) {
    await assert.rejects(action(), { code: "closed" });
  }
  assert.equal(calls.length, 1);
  assert.equal(inbox.summary().loaded, 0);
  assert.equal(client.threadListeners.size, 0);
  assert.equal(client.pendingThreads.size, 0);
});

test("pending refreshes report loading with the previous rows and reject row writes", async () => {
  let started;
  let finish;
  const ready = new Promise(resolve => { started = resolve; });
  const calls = [];
  const client = new GitHubClient({ run: async args => {
    calls.push(args);
    if (calls.length === 1) return http([thread("1")]);
    started();
    return new Promise(resolve => { finish = () => resolve(http([thread("2")])); });
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  const pending = inbox.refresh({ force: true });
  try {
    await ready;
    assert.equal(inbox.summary().status, "loading");
    assert.equal(inbox.summary().loaded, 1);
    await assert.rejects(inbox.markRead({ id: "1" }), { code: "busy" });
    await assert.rejects(inbox.markDone({ id: "1" }), { code: "busy" });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(args => args.includes("GET")));
  } finally {
    finish();
    await pending;
  }
  assert.equal(inbox.summary().status, "ready");
  assert.deepEqual(inbox.loadedItems().map(item => item.id), ["2"]);
  inbox.close();
});

test("active repository batches block refresh, pagination and row reads without additional requests", async () => {
  let started;
  let finish;
  const ready = new Promise(resolve => { started = resolve; });
  const calls = [];
  const client = new GitHubClient({ run: async args => {
    calls.push(args);
    if (!args.includes("PATCH")) return http([thread("1"), thread("2")], { link: next });
    started();
    return new Promise(resolve => { finish = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); });
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  const { repository, selectionKey } = inbox.groups()[0];
  inbox.batch.start({ repository, selectionKey });
  const token = { token: inbox.batch.snapshot().token };
  try {
    await ready;
    for (const action of [
      () => inbox.refresh(),
      () => inbox.refresh({ force: true }),
      () => inbox.more(),
      () => inbox.markRead({ id: "2" }),
      () => inbox.markDone({ id: "2" }),
    ]) {
      await assert.rejects(action(), { code: "busy" });
    }
    assert.equal(calls.length, 2);
    assert.equal(inbox.summary().loaded, 2);
  } finally {
    inbox.batch.cancel(token);
    finish();
    await inbox.batch.done;
    inbox.close();
  }
  assert.equal(calls.length, 2);
  assert.equal(client.threadReservations.size, 0);
  assert.equal(client.pendingThreads.size, 0);
});

test("pagination rejects an unopened inbox and an exhausted page without requesting more data", async () => {
  let calls = 0;
  const inbox = new Inbox(new GitHubClient({ run: async () => {
    calls++;
    return http([thread()]);
  } }));
  await assert.rejects(inbox.more(), { code: "no_more_pages" });
  assert.equal(calls, 0);
  await inbox.refresh();
  await assert.rejects(inbox.more(), { code: "no_more_pages" });
  assert.equal(calls, 1);
  assert.equal(inbox.summary().status, "ready");
  assert.equal(inbox.summary().loaded, 1);
  inbox.close();
});

test("loading an older page cannot hide a stale error on existing pages", async () => {
  let now = 0;
  let fail = false;
  const client = new GitHubClient({ now: () => now, run: async args => {
    if (fail && args.at(-1).includes("page=1")) return http({}, {}, 500);
    return http([thread(args.at(-1).includes("page=1") ? "1" : "2")],
      args.at(-1).includes("page=1") ? { link: next } : {});
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  now = POLL_MS;
  fail = true;
  await assert.rejects(inbox.refresh());
  now = client.blockedUntil;
  await inbox.more();
  assert.equal(inbox.summary().loaded, 2);
  assert.equal(inbox.summary().status, "stale");
  assert.equal(inbox.summary().error.code, "github_http");
});
