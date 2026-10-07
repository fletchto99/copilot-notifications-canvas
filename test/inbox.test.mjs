import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, POLL_MS } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { http, next, thread } from "./fixtures.mjs";

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

test("search is local, read items are excluded, and summaries never contain personal content", async () => {
  let calls = 0;
  const client = new GitHubClient({ run: async () => {
    calls++;
    return http([thread(), thread("2", { unread: false })]);
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  await inbox.setFilters({ query: "widgets" });
  assert.equal(calls, 1);
  assert.equal(inbox.summary().searchActive, true);
  await inbox.setFilters({ mode: "unread" });
  assert.equal(calls, 1);
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
  inbox.onRead("1");
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
  assert.deepEqual(filtered.attentionCounts, { all: 2, review_requested: 1, mentioned: 1, assigned: 0, participating: 0 });
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
  assert.deepEqual(inbox.summary().attentionCounts, { all: 3, review_requested: 2, mentioned: 1, assigned: 0, participating: 0 });
  assert.deepEqual(inbox.filters, { mode: "unread", query: "notification 3", attention: "review_requested" });
  await assert.rejects(inbox.setFilters({ attention: "bad" }), { code: "invalid_filters" });
  assert.equal(inbox.filters.attention, "review_requested");
  await inbox.setFilters({ attention: "all" });
  assert.equal(inbox.filters.query, "notification 3");
  await inbox.setFilters({ query: "no matching title" });
  assert.equal(inbox.summary().matching, 0);
  assert.deepEqual(inbox.summary().attentionCounts, { all: 3, review_requested: 2, mentioned: 1, assigned: 0, participating: 0 });
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
  assert.deepEqual(inbox.snapshot().attentionCounts, { all: 1, review_requested: 0, mentioned: 0, assigned: 1, participating: 0 });
  fail = true;
  await assert.rejects(inbox.refresh({ force: true }), { code: "github_http" });
  assert.equal(inbox.summary().status, "stale");
  assert.deepEqual(inbox.snapshot().attentionCounts, { all: 1, review_requested: 0, mentioned: 0, assigned: 1, participating: 0 });
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
  ]) {
    await assert.rejects(action(), { code: "closed" });
  }
  assert.equal(calls.length, 1);
  assert.equal(inbox.summary().loaded, 0);
  assert.equal(client.readListeners.size, 0);
  assert.equal(client.pendingReads.size, 0);
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
  assert.equal(client.readReservations.size, 0);
  assert.equal(client.pendingReads.size, 0);
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
