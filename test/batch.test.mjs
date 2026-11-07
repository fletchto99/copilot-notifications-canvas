import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { GitHubClient, POLL_MS } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { InboxError, normalizeThreads } from "../src/model.mjs";
import { startServer } from "../src/server.mjs";
import { http, inboxNext as next, thread } from "./fixtures.mjs";

const ok = "HTTP/2 205 Reset Content\r\n\r\n";
const settle = () => new Promise(resolve => setImmediate(resolve));
const laterThread = id => thread(id, { updated_at: "2026-01-11T12:00:00Z" });

test("batch eligibility ignores discarded duplicates within one response", async t => {
  for (const action of ["read", "done"]) {
    for (const tied of [false, true]) {
      const { inbox, writes, methods } = await fixture({ rows: [
        thread("1", { unread: action !== "read", updated_at: "2026-01-10T12:00:00Z" }),
        thread("1", { unread: action === "read", updated_at: tied ? "2026-01-10T12:00:00Z" : "2026-01-10T13:00:00Z" }),
      ] });
      t.after(() => inbox.close());
      assert.equal(inbox.loadedItems().length, 1);
      assert.equal(inbox.loadedItems()[0].unread, action === "read");
      inbox.batch.start({ ...selection(inbox), action });
      await inbox.batch.done;
      assert.equal(inbox.batch.snapshot(), null);
      assert.deepEqual(writes, ["/notifications/threads/1"]);
      assert.deepEqual(methods, [action === "read" ? "PATCH" : "DELETE"]);
    }
  }
});

async function fixture({ rows = [thread("1"), thread("2"), thread("3")], run, sleep } = {}) {
  let now = 0;
  const writes = [];
  const methods = [];
  const waits = [];
  const client = new GitHubClient({
    now: () => now,
    sleep: sleep ?? (async delay => { waits.push(delay); now += delay; }),
    run: async (args, options) => {
      const method = args[args.indexOf("--method") + 1];
      if (method !== "GET") {
        writes.push(args.at(-1));
        methods.push(method);
      }
      return run ? run(args, options) : method === "DELETE" ? "HTTP/2 204 No Content\r\n\r\n" :
        method === "PATCH" ? ok : http(rows, { etag: '"synthetic"' });
    },
  });
  const inbox = new Inbox(client);
  await inbox.refresh();
  return { inbox, client, writes, methods, waits, advance: (milliseconds = POLL_MS) => { now += milliseconds; } };
}

function selection(inbox, repository = "example/widgets") {
  const group = inbox.snapshot().groups.find(group => group.repository === repository);
  return { repository, selectionKey: group.selectionKey };
}

function start(inbox, repository = "example/widgets", action = "read") {
  inbox.batch.start({ ...selection(inbox, repository), action });
  return { token: inbox.batch.snapshot().token };
}

function dateSelection(inbox, date, timeZone = "UTC", action = "done") {
  return { scope: "date", date, timeZone, action, selectionKey: inbox.snapshot().selectionKey };
}

test("date batches select one local calendar day across repositories, including 23- and 25-hour days", async t => {
  for (const [date, start, end] of [
    ["2026-03-08", "2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z"],
    ["2026-11-01", "2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z"],
  ]) {
    for (const action of ["read", "done"]) {
      const rows = [
        thread("1", { updated_at: new Date(Date.parse(start) - 1).toISOString() }),
        thread("2", { updated_at: start, repository: { full_name: "example/alpha" } }),
        thread("3", { updated_at: new Date(Date.parse(end) - 1).toISOString(), repository: { full_name: "example/beta" } }),
        thread("4", { updated_at: end }),
      ];
      const { inbox, writes, methods, client } = await fixture({ rows });
      t.after(() => inbox.close());
      inbox.batch.start(dateSelection(inbox, date, "America/Los_Angeles", action));
      assert.equal(inbox.batch.snapshot().scope, "date");
      assert.equal(inbox.batch.snapshot().date, date);
      assert.equal(inbox.batch.snapshot().timeZone, "America/Los_Angeles");
      assert.equal(inbox.batch.snapshot().total, 2);
      assert.doesNotMatch(JSON.stringify(inbox.summary()), /"date":|"timeZone":|America\/|example\/|selectionKey|"token"|"items"/);
      await inbox.batch.done;
      assert.deepEqual(writes, ["/notifications/threads/2", "/notifications/threads/3"]);
      assert.deepEqual(methods, [action === "done" ? "DELETE" : "PATCH", action === "done" ? "DELETE" : "PATCH"]);
      assert.deepEqual(inbox.loadedItems().filter(item => action === "done" || item.unread).map(item => item.id), ["1", "4"]);
      assert.equal(client.threadReservations.size, 0);
    }
  }
});

test("date batch inputs reject invalid days, zones, and stale filtered snapshots without writes", async t => {
  const { inbox, writes } = await fixture();
  t.after(() => inbox.close());
  const input = dateSelection(inbox, "2026-01-10");
  for (const value of [null, "2026-2-10", "2026-02-30", "2026-13-01"]) {
    assert.throws(() => inbox.batch.start({ ...input, date: value }), { code: "invalid_selection" });
  }
  for (const value of [undefined, null, "", "x".repeat(129)]) {
    assert.throws(() => inbox.batch.start({ ...input, timeZone: value }), { code: "invalid_selection" });
  }
  assert.throws(() => inbox.batch.start({ ...input, timeZone: "Invalid/Zone" }), { code: "invalid_time_zone" });
  assert.throws(() => inbox.batch.start({ ...input, repository: "example/widgets" }), { code: "invalid_selection" });
  assert.throws(() => inbox.batch.start({ ...input, ids: ["1"] }), { code: "invalid_selection" });
  assert.throws(() => inbox.batch.start({ ...input, date: "2026-01-09" }), { code: "selection_changed" });
  assert.throws(() => inbox.batch.start({ ...input, selectionKey: inbox.groups()[0].selectionKey }), { code: "selection_changed" });
  await inbox.setFilters({ attention: "review_requested" });
  assert.throws(() => inbox.batch.start(input), { code: "selection_changed" });
  assert.deepEqual(writes, []);
});

test("date retries preserve the original day and zone and cannot reach changed dates or new arrivals", async t => {
  let attempts = 0;
  const rows = [
    thread("1", { updated_at: "2026-01-12T10:00:00Z", reason: "mention" }),
    thread("2", { updated_at: "2026-01-12T11:00:00Z", reason: "mention", repository: { full_name: "example/other" } }),
    thread("3", { updated_at: "2026-01-12T12:00:00Z", reason: "mention" }),
    thread("9", { updated_at: "2026-01-13T12:00:00Z", reason: "mention" }),
  ];
  const { inbox, writes, methods, advance } = await fixture({ run: args => {
    if (args.includes("GET")) return http(rows);
    return ++attempts === 2 ? http({}, {}, 500) : "HTTP/2 204 No Content\r\n\r\n";
  } });
  t.after(() => inbox.close());
  inbox.batch.start(dateSelection(inbox, "2026-01-12"));
  const token = { token: inbox.batch.snapshot().token };
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().succeeded, 1);
  assert.equal(inbox.batch.snapshot().failed, 1);
  inbox.pages[0].items.find(item => item.id === "2").updatedAt = "2026-01-13T11:00:00.000Z";
  inbox.pages[0].items.push(...normalizeThreads([thread("4", { updated_at: "2026-01-12T13:00:00Z", reason: "mention" })]));
  await inbox.setFilters({ attention: "mentioned" });
  assert.throws(() => inbox.batch.retry({ ...token, date: "2026-01-13" }), { code: "invalid_batch" });
  assert.throws(() => inbox.batch.retry({ ...token, timeZone: "Asia/Tokyo" }), { code: "invalid_batch" });
  advance();
  advance();
  inbox.batch.retry(token);
  assert.equal(inbox.batch.snapshot().date, "2026-01-12");
  assert.equal(inbox.batch.snapshot().timeZone, "UTC");
  assert.equal(inbox.batch.snapshot().scope, "date");
  assert.equal(inbox.batch.snapshot().action, "done");
  assert.equal(inbox.batch.snapshot().total, 1);
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/3"]);
  assert.deepEqual(methods, ["DELETE", "DELETE", "DELETE"]);
  assert.deepEqual(inbox.loadedItems().map(item => item.id).sort(), ["2", "4", "9"]);
});

test("the protected date batch HTTP path dispatches only the selected day's threads", async t => {
  const { inbox, writes } = await fixture({ rows: [
    thread("1"), thread("2", { repository: { full_name: "example/other" } }), laterThread("3"),
  ] });
  const server = await startServer(inbox);
  t.after(() => server.close());
  const url = new URL(server.url);
  const response = await fetch(`${url.origin}/api/batch/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
    body: JSON.stringify(dateSelection(inbox, "2026-01-10")),
  });
  assert.equal(response.status, 202);
  const snapshot = await response.json();
  assert.equal(snapshot.batch.scope, "date");
  assert.equal(snapshot.batch.date, "2026-01-10");
  assert.equal(snapshot.batch.total, 2);
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2"]);
  assert.deepEqual(inbox.loadedItems().map(item => item.id), ["3"]);
});

test("Done batches issue spaced DELETEs for only loaded attention and search matches and synchronize other panels", async t => {
  const rows = [
    thread("1", { reason: "mention" }), thread("2", { reason: "mention" }),
    thread("3", { reason: "review_requested" }),
    thread("4", { reason: "mention", repository: { full_name: "example/other" } }),
    thread("5", { reason: "mention", subject: { title: "Excluded", type: "Issue", url: null } }),
  ];
  const { inbox, client, writes, methods, waits } = await fixture({
    run: async args => args.includes("DELETE") ? "HTTP/2 204 No Content\r\n\r\n" : http(rows, { link: next }),
  });
  const other = new Inbox(client);
  t.after(() => { inbox.close(); other.close(); });
  await other.refresh();
  await inbox.setFilters({ attention: "mentioned", query: "notification" });
  start(inbox, "example/widgets", "done");
  assert.equal(inbox.batch.snapshot().action, "done");
  assert.equal(inbox.batch.snapshot().total, 2);
  assert.equal(inbox.batch.snapshot().searchActive, true);
  assert.equal(inbox.summary().batch.action, "done");
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /example\/|selectionKey|token|Synthetic notification/);
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2"]);
  assert.deepEqual(methods, ["DELETE", "DELETE"]);
  assert.deepEqual(waits, [1000]);
  assert.equal(inbox.batch.snapshot(), null);
  for (const panel of [inbox, other]) {
    assert.deepEqual(panel.loadedItems().map(item => item.id), ["3", "4", "5"]);
    assert.equal(panel.summary().needsRefresh, true);
    assert.equal(panel.summary().hasMore, true);
  }
  assert.equal(client.threadReservations.size, 0);
});

test("retry retains Done, never repeats successes or adds arrivals, and does not change the next batch default", async t => {
  let fail = true;
  let deletes = 0;
  const { inbox, client, writes, methods, advance } = await fixture({ run: async args => {
    if (args.includes("GET")) return http([thread("1"), thread("2"), thread("3")]);
    if (args.includes("PATCH")) return ok;
    return ++deletes === 2 && fail ? http({}, {}, 500) : "HTTP/2 204 No Content\r\n\r\n";
  } });
  t.after(() => inbox.close());
  const token = start(inbox, "example/widgets", "done");
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().action, "done");
  assert.equal(inbox.batch.snapshot().succeeded, 1);
  assert.equal(inbox.batch.snapshot().failed, 1);
  assert.equal(inbox.batch.snapshot().notAttempted, 1);
  inbox.pages[0].items.push(...normalizeThreads([thread("4")]));
  assert.throws(() => inbox.batch.retry({ ...token, action: "read" }), { code: "invalid_batch" });
  assert.throws(() => inbox.batch.retry(token), { code: "github_http" });
  assert.equal(methods.length, 2);
  advance();
  advance();
  fail = false;
  inbox.batch.retry(token);
  assert.equal(inbox.batch.snapshot().action, "done");
  assert.equal(inbox.batch.snapshot().total, 2);
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/2", "/notifications/threads/3"]);
  assert.deepEqual(methods, ["DELETE", "DELETE", "DELETE", "DELETE"]);
  assert.deepEqual(inbox.loadedItems().map(item => item.id), ["4"]);
  inbox.batch.start(selection(inbox));
  assert.equal(inbox.batch.snapshot().action, "read");
  await inbox.batch.done;
  assert.equal(methods.at(-1), "PATCH");
  assert.equal(client.threadReservations.size, 0);
});

test("Done rejects invalid actions and rechecks selected activity after waiting for write spacing", async t => {
  let release;
  const { inbox, client, writes } = await fixture({ sleep: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => inbox.close());
  for (const action of [undefined, null, "", "DELETE", "unread", true, {}, []]) {
    assert.throws(() => inbox.batch.start({ ...selection(inbox), action }), { code: "invalid_selection" });
  }
  client.writeAvailableAt = 1000;
  start(inbox, "example/widgets", "done");
  await settle();
  client.cache.values().next().value.items = normalizeThreads([laterThread("1"), laterThread("2"), laterThread("3")]);
  release();
  await inbox.batch.done;
  assert.deepEqual(writes, []);
  assert.equal(inbox.batch.snapshot().skipped, 3);
  assert.equal(inbox.batch.snapshot().action, "done");
  assert.equal(client.threadReservations.size, 0);
});

test("stopping an in-flight Done batch waits for confirmation and retains Done for the remaining retry", async t => {
  let release;
  let hold = true;
  const { inbox, client, methods } = await fixture({ run: async args => {
    if (args.includes("GET")) return http([thread("1"), thread("2")]);
    assert.ok(args.includes("DELETE"));
    if (hold) await new Promise(resolve => { release = resolve; });
    return "HTTP/2 204 No Content\r\n\r\n";
  } });
  const other = new Inbox(client);
  t.after(() => { inbox.close(); other.close(); });
  await other.refresh();
  const token = start(inbox, "example/widgets", "done");
  await settle();
  await assert.rejects(other.markRead({ id: "2" }), { code: "busy" });
  await assert.rejects(other.markDone({ id: "2" }), { code: "busy" });
  assert.throws(() => start(other), { code: "busy" });
  inbox.batch.cancel(token);
  assert.equal(inbox.batch.snapshot().status, "stopping");
  release();
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().status, "cancelled");
  assert.equal(inbox.batch.snapshot().succeeded, 1);
  assert.equal(inbox.batch.snapshot().notAttempted, 1);
  assert.deepEqual(methods, ["DELETE"]);
  hold = false;
  inbox.batch.retry(token);
  assert.equal(inbox.batch.snapshot().action, "done");
  await inbox.batch.done;
  assert.deepEqual(methods, ["DELETE", "DELETE"]);
  assert.equal(client.threadReservations.size, 0);
});

test("closing a Done batch cancels queued and in-flight work and releases all reservations", async () => {
  for (const queued of [true, false]) {
    const interrupted = signal => new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(new InboxError("closed", "Synthetic cancellation", 410)), { once: true }));
    const { inbox, client, methods } = await fixture({
      sleep: (_delay, _value, { signal }) => interrupted(signal),
      run: (args, { signal }) => args.includes("GET") ? http([thread("1"), thread("2")]) : interrupted(signal),
    });
    if (queued) client.writeAvailableAt = 1000;
    start(inbox, "example/widgets", "done");
    await settle();
    inbox.close();
    await inbox.batch.done;
    assert.equal(inbox.batch.snapshot(), null);
    assert.equal(client.pendingThreads.size, 0);
    assert.equal(client.threadReservations.size, 0);
    assert.deepEqual(methods, queued ? [] : ["DELETE"]);
  }
});

test("HTTP batch starts accept an explicit Done action but reject unknown actions before any writes", async t => {
  const { inbox, methods } = await fixture();
  const server = await startServer(inbox);
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const request = body => fetch(`${url.origin}/api/batch/start`, { method: "POST", headers, body: JSON.stringify(body) });
  const input = selection(inbox);
  assert.equal((await request({ ...input, action: "DELETE" })).status, 400);
  assert.deepEqual(methods, []);
  const response = await request({ ...input, action: "done" });
  assert.equal(response.status, 202);
  const snapshot = await response.json();
  assert.equal(snapshot.batch.action, "done");
  assert.equal(snapshot.batch.total, 3);
  await inbox.batch.done;
  assert.deepEqual(methods, ["DELETE", "DELETE", "DELETE"]);
});

test("one request captures only shown loaded search matches and can stop before dispatch", async () => {
  const rows = [thread("1"), thread("2"), thread("3", { repository: { full_name: "example/other" } })];
  const { inbox, writes } = await fixture({
    run: async args => args.includes("PATCH") ? ok : http(rows, { link: next }),
  });
  await inbox.setFilters({ query: "notification 1" });
  const token = start(inbox);
  assert.equal(inbox.batch.snapshot().total, 1);
  assert.equal(inbox.batch.snapshot().searchActive, true);
  assert.equal(inbox.batch.snapshot().repository, "example/widgets");
  assert.equal(inbox.summary().hasMore, true);
  const summary = JSON.stringify(inbox.summary());
  assert.doesNotMatch(summary, /example\/|selectionKey|token/);
  inbox.batch.cancel(token);
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().status, "cancelled");
  assert.equal(inbox.batch.snapshot().notAttempted, 1);
  assert.deepEqual(writes, []);
});

test("strict bounded selection requests reject unknown, forged, stale, cross-repo or client-supplied IDs", async () => {
  const { inbox, writes } = await fixture();
  const group = inbox.groups()[0];
  for (const input of [null, [], {}, { repository: group.repository, selectionKey: "wrong" },
    { repository: "example/other", selectionKey: group.selectionKey },
    { repository: group.repository, selectionKey: "a".repeat(64) },
    { repository: group.repository, selectionKey: group.selectionKey, ids: ["1", "1"] },
    { repository: group.repository, ids: ["../2"] }]) {
    assert.throws(() => inbox.batch.start(input));
  }
  await inbox.setFilters({ query: "notification 1" });
  assert.throws(() => inbox.batch.start({ repository: group.repository, selectionKey: group.selectionKey }),
    { code: "selection_changed" });
  assert.deepEqual(writes, []);
});

test("repository reads respect attention and search, and filter changes invalidate even identical selections", async () => {
  const { inbox, writes } = await fixture({
    rows: [thread("1", { reason: "mention" }), thread("2", { reason: "review_requested" }),
      thread("3", { reason: "mention" }), thread("4", { reason: "mention", repository: { full_name: "example/other" } })],
  });
  await inbox.setFilters({ query: "notification 1" });
  const before = selection(inbox);
  await inbox.setFilters({ attention: "mentioned" });
  assert.equal(inbox.summary().matching, 1);
  assert.throws(() => inbox.batch.start(before), { code: "selection_changed" });
  start(inbox);
  await inbox.setFilters({ attention: "all" });
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/1"]);
  assert.deepEqual(inbox.loadedItems().filter(item => item.unread).map(item => item.id), ["2", "3", "4"]);
});

test("team-mention batches exclude personal mentions and other participation reasons", async t => {
  for (const action of ["read", "done"]) {
    const { inbox, writes } = await fixture({ rows: [
      thread("1", { reason: "mention" }), thread("2", { reason: "team_mention" }),
      thread("3", { reason: "review_requested" }), thread("4", { reason: "author" }),
      thread("5", { reason: "subscribed" }), thread("6", { reason: "team_mention", unread: false }),
    ] });
    t.after(() => inbox.close());
    await inbox.setFilters({ attention: "team_mentioned" });
    assert.equal(inbox.summary().matching, 2);
    start(inbox, "example/widgets", action);
    assert.equal(inbox.batch.snapshot().total, action === "read" ? 1 : 2);
    await inbox.batch.done;
    assert.deepEqual(writes, action === "read"
      ? ["/notifications/threads/2"] : ["/notifications/threads/2", "/notifications/threads/6"]);
    assert.ok(inbox.loadedItems().some(item => item.id === "1" && item.unread));
  }
});

test("retry excludes original batch items hidden by a new attention filter", async () => {
  const { inbox, writes } = await fixture({
    rows: [thread("1", { reason: "mention" }), thread("2", { reason: "review_requested" })],
  });
  const token = start(inbox);
  inbox.batch.cancel(token);
  await inbox.batch.done;
  await inbox.setFilters({ attention: "review_requested" });
  inbox.batch.retry(token);
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/2"]);
});

test("batch controls reject malformed, missing and stale operation tokens without changing the current selection", async () => {
  const { inbox, client, writes } = await fixture();
  const unknown = { token: "00000000-0000-4000-8000-000000000000" };
  for (const action of ["cancel", "retry", "dismiss"]) {
    for (const input of [undefined, null, [], {}, { token: 1 }, { token: "invalid" }, { ...unknown, ids: ["1"] }]) {
      assert.throws(() => inbox.batch[action](input), { code: "invalid_batch" });
      assert.equal(inbox.batch.snapshot(), null);
    }
    assert.throws(() => inbox.batch[action](unknown), { code: "unknown_batch" });
  }
  const stale = start(inbox);
  inbox.batch.cancel(stale);
  await inbox.batch.done;
  inbox.batch.dismiss(stale);
  const current = start(inbox);
  inbox.batch.cancel(current);
  await inbox.batch.done;
  assert.notEqual(current.token, stale.token);
  const before = inbox.batch.snapshot();
  for (const action of ["cancel", "retry", "dismiss"]) {
    for (const input of [stale, unknown]) {
      assert.throws(() => inbox.batch[action](input), { code: "unknown_batch" });
      assert.deepEqual(inbox.batch.snapshot(), before);
    }
  }
  assert.equal(inbox.summary().loaded, 3);
  assert.equal(client.threadReservations.size, 0);
  assert.deepEqual(writes, []);
});

test("dismissal is blocked during a batch and clears cancelled progress without changing unread rows", async () => {
  const { inbox, client, writes } = await fixture();
  const token = start(inbox);
  assert.throws(() => inbox.batch.dismiss(token), { code: "busy" });
  assert.equal(inbox.batch.snapshot().token, token.token);
  inbox.batch.cancel(token);
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().status, "cancelled");
  inbox.batch.dismiss(token);
  assert.equal(inbox.batch.snapshot(), null);
  assert.throws(() => inbox.batch.dismiss(token), { code: "unknown_batch" });
  assert.equal(inbox.summary().loaded, 3);
  assert.equal(client.threadReservations.size, 0);
  assert.deepEqual(writes, []);
});

test("group size is bounded by loaded rows, not an arbitrary silent cap or an oversized HTTP ID array", async () => {
  const { inbox } = await fixture({ rows: Array.from({ length: 2000 }, (_, index) => thread(String(index + 1))) });
  const group = inbox.groups()[0];
  const input = { repository: group.repository, selectionKey: group.selectionKey };
  assert.ok(JSON.stringify(input).length < 256);
  inbox.batch.start(input);
  assert.equal(inbox.batch.snapshot().total, 2000);
  inbox.batch.cancel({ token: inbox.batch.snapshot().token });
  await inbox.batch.done;
});

test("one-click batches make spaced PATCH calls, update shared panels, and quietly clear completed state", async () => {
  const { inbox, client, writes, waits, advance } = await fixture();
  const other = new Inbox(client);
  await other.refresh();
  const input = selection(inbox);
  start(inbox);
  assert.throws(() => inbox.batch.start(input), { code: "busy" });
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot(), null);
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/3"]);
  assert.deepEqual(waits, [1000, 1000]);
  for (const panel of [inbox, other]) {
    assert.equal(panel.summary().loaded, 3);
    assert.equal(panel.summary().unread, 0);
    assert.equal(panel.summary().needsRefresh, true);
  }
  assert.throws(() => inbox.batch.start(input), { code: "selection_changed" });
  assert.equal(writes.length, 3);
  assert.equal(client.threadReservations.size, 0);
  client.run = async () => "HTTP/2 304 Not modified\r\n\r\n";
  advance();
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 3);
  assert.equal(inbox.summary().unread, 0);
  client.run = async () => http([laterThread("1")]);
  advance();
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 1);
});

test("a clicked selection excludes new arrivals and skips changed or no-longer-loaded captured rows", async () => {
  const { inbox, writes } = await fixture();
  start(inbox);
  inbox.pages = [{ ...inbox.pages[0], items: normalizeThreads([thread("1"), laterThread("2"), thread("4")]) }];
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/1"]);
  assert.equal(inbox.batch.snapshot().succeeded, 1);
  assert.equal(inbox.batch.snapshot().skipped, 2);
  assert.deepEqual(inbox.loadedItems().filter(item => item.unread).map(item => item.id).sort(), ["2", "4"]);
});

test("newer cache activity is rechecked after queued write spacing, before a PATCH is dispatched", async () => {
  let release;
  const { inbox, client, writes } = await fixture({
    sleep: () => new Promise(resolve => { release = resolve; }),
  });
  client.writeAvailableAt = 1000;
  start(inbox);
  await settle();
  const page = [...client.cache.values()][0];
  page.items = normalizeThreads([laterThread("1"), laterThread("2"), laterThread("3")]);
  release();
  await inbox.batch.done;
  assert.deepEqual(writes, []);
  assert.equal(inbox.batch.snapshot().skipped, 3);
});

test("duplicate groups, overlapping per-row reads and other-panel batches are blocked", async () => {
  let release;
  const { inbox, client, writes } = await fixture({
    run: async args => args.includes("PATCH") ? new Promise(resolve => { release = () => resolve(ok); }) : http([thread("1")]),
  });
  const other = new Inbox(client);
  await other.refresh();
  start(inbox);
  assert.throws(() => start(inbox), { code: "busy" });
  await assert.rejects(inbox.markRead({ id: "1" }), { code: "busy" });
  await assert.rejects(inbox.markDone({ id: "1" }), { code: "busy" });
  await inbox.setFilters({ query: "changed" });
  await assert.rejects(inbox.setFilters({ mode: "unread" }), { code: "busy" });
  await settle();
  await assert.rejects(other.markRead({ id: "1" }), { code: "busy" });
  await assert.rejects(other.markDone({ id: "1" }), { code: "busy" });
  assert.throws(() => start(other), { code: "busy" });
  assert.equal(other.batch.snapshot(), null);
  release();
  await inbox.batch.done;
  assert.equal(writes.length, 1);
});

test("a group click cannot overlap a previously issued per-row mutation", async () => {
  let release;
  const { inbox } = await fixture({
    run: async args => args.includes("PATCH") ? new Promise(resolve => { release = () => resolve(ok); }) : http([thread("1")]),
  });
  const pending = inbox.markRead({ id: "1" });
  assert.throws(() => start(inbox), { code: "busy" });
  await settle();
  release();
  await pending;
});

test("disjoint batches and rows run together with isolated cancellation, retries, and shared reservations", async t => {
  let release;
  const rows = [
    thread("1"), thread("2"), thread("6", { unread: false }),
    thread("3", { repository: { full_name: "example/other" } }),
    thread("4", { repository: { full_name: "example/other" } }),
    thread("5", { repository: { full_name: "example/solo" } }),
  ];
  const { inbox, client, writes, methods } = await fixture({ run: async args => {
    if (args.includes("GET")) return http(rows);
    if (args.at(-1).endsWith("/1")) await new Promise(resolve => { release = resolve; });
    return args.includes("DELETE") ? "HTTP/2 204 No Content\r\n\r\n" : ok;
  } });
  const other = new Inbox(client);
  t.after(() => { release?.(); inbox.close(); other.close(); });
  await other.refresh();
  const first = start(inbox);
  const row = inbox.markDone({ id: "5" });
  const second = start(inbox, "example/other", "done");
  await settle();
  assert.equal(inbox.batch.snapshots().length, 2);
  assert.equal(inbox.batch.locked, true);
  assert.deepEqual(new Set(inbox.snapshot().lockedThreadIds), new Set(["1", "2", "3", "4", "5", "6"]));
  assert.deepEqual(new Set(other.snapshot().lockedThreadIds), new Set(["1", "2", "3", "4", "5", "6"]));
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /example\/|token|selectionKey|lockedThreadIds|remainingThreadIds|snapshotVersion|Synthetic notification/);
  await assert.rejects(inbox.markDone({ id: "6" }), { code: "busy" });
  await assert.rejects(other.markDone({ id: "2" }), { code: "busy" });
  assert.throws(() => start(other, "example/other"), { code: "busy" });
  inbox.batch.cancel(second);
  assert.equal(inbox.batch.snapshots().find(batch => batch.token === first.token).status, "running");
  release();
  await Promise.all([inbox.batch.done, row]);
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/5", "/notifications/threads/2"]);
  assert.deepEqual(methods, ["PATCH", "DELETE", "PATCH"]);
  assert.equal(inbox.batch.snapshot().token, second.token);
  assert.equal(inbox.batch.snapshot().status, "cancelled");
  assert.equal(inbox.batch.snapshot().notAttempted, 2);
  assert.equal(client.threadReservations.size, 0);
  inbox.batch.retry(second);
  await inbox.batch.done;
  assert.deepEqual(writes.slice(-2), ["/notifications/threads/3", "/notifications/threads/4"]);
  assert.deepEqual(methods.slice(-2), ["DELETE", "DELETE"]);
  assert.deepEqual(inbox.batch.snapshots(), []);
  assert.deepEqual(inbox.snapshot().lockedThreadIds, []);
});

test("search and attention changes never change a running batch's captured targets in any scope", async t => {
  for (const scope of ["repository", "shown", "date"]) {
    for (const action of ["read", "done"]) {
      let release;
      const rows = [
        thread("1", { reason: "mention" }), thread("2", { reason: "mention" }),
        thread("3", { reason: "review_requested" }),
      ];
      const { inbox, writes, methods } = await fixture({ run: async args => {
        if (args.includes("GET")) return http(rows);
        if (args.at(-1).endsWith("/1")) await new Promise(resolve => { release = resolve; });
        return args.includes("DELETE") ? "HTTP/2 204 No Content\r\n\r\n" : ok;
      } });
      t.after(() => { release?.(); inbox.close(); });
      await inbox.setFilters({ attention: "mentioned" });
      inbox.batch.start(scope === "repository" ? { ...selection(inbox), action } :
        scope === "shown" ? { scope, action, selectionKey: inbox.snapshot().selectionKey } :
          dateSelection(inbox, "2026-01-10", "UTC", action));
      await settle();
      const before = inbox.batch.snapshot();
      await inbox.setFilters({ query: "notification 3", attention: "review_requested" });
      assert.equal(inbox.summary().matching, 1);
      assert.deepEqual(inbox.batch.snapshot(), before);
      await assert.rejects(inbox.refresh({ force: true }), { code: "busy" });
      await assert.rejects(inbox.setFilters({ mode: "unread" }), { code: "busy" });
      release();
      await inbox.batch.done;
      assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2"]);
      assert.deepEqual(methods, [action === "done" ? "DELETE" : "PATCH", action === "done" ? "DELETE" : "PATCH"]);
      assert.equal(inbox.groups()[0].items[0].id, "3");
    }
  }
});

test("protected snapshots distinguish queued rows from dispatched writes without leaking identities in summaries", async t => {
  const releases = [];
  const { inbox, client } = await fixture({ run: args => args.includes("GET") ? http([thread("1"), thread("2")]) :
    new Promise(resolve => { releases.push(() => resolve(args.includes("PATCH") ? ok : "HTTP/2 204 No Content\r\n\r\n")); }),
  });
  t.after(() => { releases.forEach(release => release()); inbox.close(); });
  const read = inbox.markRead({ id: "1" });
  const done = inbox.markDone({ id: "2" });
  assert.deepEqual(inbox.snapshot().threadWrites, [
    { id: "1", action: "read", inFlight: false }, { id: "2", action: "done", inFlight: false },
  ]);
  await settle();
  const old = inbox.snapshot();
  assert.deepEqual(old.threadWrites.map(write => write.inFlight), [true, false]);
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /threadWrites|"id"|lockedThreadIds/);
  releases[0]();
  await read;
  await settle();
  assert.deepEqual(inbox.snapshot().threadWrites, [{ id: "2", action: "done", inFlight: true }]);
  assert.equal(old.threadWrites[1].inFlight, false);
  releases[1]();
  await done;
  assert.equal(client.threadWrites.size, 0);
});

test("dismissing a stopped result and closing active batches affect only their own operations", async t => {
  let entered;
  const dispatched = new Promise(resolve => { entered = resolve; });
  const { inbox, client } = await fixture({ run: (args, { signal }) => {
    if (args.includes("GET")) return http([thread("1"), thread("2", { repository: { full_name: "example/other" } })]);
    entered();
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  } });
  t.after(() => inbox.close());
  const stopped = start(inbox);
  inbox.batch.cancel(stopped);
  await inbox.batch.done;
  const active = start(inbox, "example/other");
  await dispatched;
  inbox.batch.dismiss(stopped);
  assert.equal(inbox.batch.snapshot().token, active.token);
  assert.throws(() => inbox.batch.retry(active), { code: "busy" });
  start(inbox);
  assert.equal(inbox.batch.snapshots().length, 2);
  const done = inbox.batch.done;
  inbox.close();
  await done;
  assert.deepEqual(inbox.batch.snapshots(), []);
  assert.equal(client.pendingThreads.size, 0);
  assert.equal(client.threadReservations.size, 0);
});

test("auth/rate/network failures stop the batch with exact partial counts and retry never repeats successes", async () => {
  for (const failure of [http({}, {}, 401), http({}, { "retry-after": "600" }, 429),
    new InboxError("gh_failed", "Synthetic connection failure")]) {
    let count = 0;
    let failing = true;
    const { inbox, client, writes, advance } = await fixture({
      run: async args => {
        if (!args.includes("PATCH")) return http([thread("1"), thread("2"), thread("3")]);
        if (++count === 2 && failing) {
          if (failure instanceof Error) throw failure;
          return failure;
        }
        return ok;
      },
    });
    const token = start(inbox);
    await inbox.batch.done;
    assert.deepEqual(
      (({ succeeded, failed, skipped, notAttempted }) => ({ succeeded, failed, skipped, notAttempted }))(inbox.batch.snapshot()),
      { succeeded: 1, failed: 1, skipped: 0, notAttempted: 1 });
    assert.equal(writes.length, 2);
    assert.equal(inbox.summary().loaded, 3);
    assert.equal(inbox.summary().unread, 2);
    failing = false;
    advance(client.blockedUntil - client.now());
    inbox.batch.retry(token);
    assert.equal(inbox.batch.snapshot().status, "running");
    assert.equal(inbox.batch.snapshot().total, 2);
    assert.throws(() => inbox.batch.retry(token), { code: "unknown_batch" });
    await inbox.batch.done;
    assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/2", "/notifications/threads/3"]);
    assert.equal(inbox.summary().loaded, 3);
    assert.equal(inbox.summary().unread, 0);
  }
});

test("retry keeps the old selection and respects a newly narrowed search", async () => {
  let writes = 0;
  const { inbox, client } = await fixture({
    run: async args => !args.includes("PATCH") ? http([thread("1"), thread("2"), thread("3")]) :
      ++writes === 1 ? http({}, {}, 500) : ok,
  });
  const token = start(inbox);
  await inbox.batch.done;
  await inbox.setFilters({ query: "notification 2" });
  client.blockedUntil = 0;
  inbox.batch.retry(token);
  assert.equal(inbox.batch.snapshot().total, 1);
  await inbox.batch.done;
  assert.equal(inbox.loadedItems().find(item => item.id === "2").unread, false);
  assert.equal(inbox.summary().loaded, 3);
  assert.equal(inbox.summary().unread, 2);
});

test("retry rejects an entirely hidden or changed selection without writing or replacing its partial result", async t => {
  for (const change of ["hidden", "updated"]) {
    await t.test(change, async () => {
      const { inbox, client, writes } = await fixture({
        run: async args => args.includes("PATCH") ? http({}, {}, 500) : http([thread("1")]),
      });
      const token = start(inbox);
      await inbox.batch.done;
      assert.equal(inbox.batch.snapshot().failed, 1);
      client.blockedUntil = 0;
      if (change === "hidden") await inbox.setFilters({ query: "no matching notifications" });
      else inbox.pages = [{ ...inbox.pages[0], items: normalizeThreads([laterThread("1")]) }];
      const before = inbox.batch.snapshot();
      assert.throws(() => inbox.batch.retry(token), { code: "no_remaining" });
      assert.deepEqual(inbox.batch.snapshot(), before);
      assert.equal(inbox.summary().loaded, 1);
      assert.equal(client.threadReservations.size, 0);
      assert.deepEqual(writes, ["/notifications/threads/1"]);
    });
  }
});

test("cancellation while a request is in flight waits for its confirmation but sends no remaining requests", async () => {
  let release;
  const { inbox, writes, client } = await fixture({
    run: async args => args.includes("PATCH") ? new Promise(resolve => { release = () => resolve(ok); }) : http([thread("1"), thread("2")]),
  });
  const token = start(inbox);
  await settle();
  inbox.batch.cancel(token);
  assert.equal(inbox.batch.snapshot().status, "stopping");
  assert.equal(inbox.batch.snapshot().inFlight, true);
  release();
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().status, "cancelled");
  assert.equal(inbox.batch.snapshot().succeeded, 1);
  assert.equal(inbox.batch.snapshot().notAttempted, 1);
  assert.equal(writes.length, 1);
  assert.equal(client.threadReservations.size, 0);
});

test("cancelling during a write delay and closing the panel abort not-yet-dispatched work", async () => {
  for (const close of [false, true]) {
    const { inbox, client, writes } = await fixture({
      sleep: (_ms, _, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    });
    client.writeAvailableAt = 1000;
    const token = start(inbox);
    await settle();
    if (close) inbox.close();
    else inbox.batch.cancel(token);
    await inbox.batch.done;
    assert.equal(writes.length, 0);
    assert.equal(client.threadReservations.size, 0);
    assert.equal(client.pendingThreads.size, 0);
    if (close) assert.equal(inbox.batch.snapshot(), null);
    else assert.equal(inbox.batch.snapshot().notAttempted, 3);
  }
});

test("unexpected transport errors become explicit partial results", async () => {
  const broken = await fixture({ run: async args => {
    if (args.includes("PATCH")) throw new Error("secret internal context");
    return http([thread("1"), thread("2")]);
  } });
  start(broken.inbox);
  await broken.inbox.batch.done;
  assert.equal(broken.inbox.batch.snapshot().failed, 1);
  assert.equal(broken.inbox.batch.snapshot().notAttempted, 1);
  assert.doesNotMatch(JSON.stringify(broken.inbox.batch.snapshot()), /secret internal/);
});

test("HTTP start returns before writes finish, status stays readable and cancellation remains responsive", async t => {
  let release;
  const { inbox, writes } = await fixture({
    run: async args => args.includes("PATCH") ? new Promise(resolve => { release = () => resolve(ok); }) : http([thread("1"), thread("2")]),
  });
  const server = await startServer(inbox);
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const post = (action, input, extra = {}) => fetch(`${url.origin}/api/batch/${action}`,
    { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(input) });
  const group = inbox.groups()[0];
  const selection = { repository: group.repository, selectionKey: group.selectionKey };
  assert.equal((await post("start", selection, { Origin: "https://evil.test" })).status, 403);
  assert.equal((await post("start", selection, { Authorization: "wrong" })).status, 403);
  assert.equal((await post("start", { ...selection, ids: ["1", "1"] })).status, 400);
  assert.equal((await fetch(`${url.origin}/api/batch/start`, { headers })).status, 405);
  assert.equal((await post("prepare", selection)).status, 404);
  const started = await post("start", selection);
  assert.equal(started.status, 202);
  const batch = (await started.json()).batch;
  const token = { token: batch.token };
  assert.equal(batch.status, "running");
  const progress = await fetch(`${url.origin}/api/state`, { headers });
  assert.equal((await progress.json()).batch.inFlight, true);
  assert.equal((await post("start", selection)).status, 409);
  const cancelling = await post("cancel", token);
  assert.equal((await cancelling.json()).batch.status, "stopping");
  release();
  await inbox.batch.done;
  assert.equal(writes.length, 1);
  const source = await readFile(new URL("../src/extension.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /name: "(?:mark_read|batch|bulk|prepare|start_batch)"/);
});

test("existing backoff prevents starting, and quota exhaustion after success leaves the rest not attempted", async () => {
  const { inbox, client, writes } = await fixture({
    run: async args => args.includes("PATCH") ?
      http(null, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999" }, 205) :
      http([thread("1"), thread("2"), thread("3")]),
  });
  client.blockedUntil = 1000;
  assert.throws(() => start(inbox), { code: "rate_limited" });
  assert.equal(inbox.batch.snapshot(), null);
  client.blockedUntil = 0;
  start(inbox);
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().succeeded, 1);
  assert.equal(inbox.batch.snapshot().failed, 0);
  assert.equal(inbox.batch.snapshot().notAttempted, 2);
  assert.equal(inbox.batch.snapshot().error.code, "rate_limited");
  assert.equal(writes.length, 1);
});

test("closing a server aborts an in-flight batch and releases its listener and reservations", async () => {
  const { inbox, client, writes } = await fixture({
    run: async (args, { signal }) => {
      if (!args.includes("PATCH")) return http([thread("1"), thread("2")]);
      return new Promise((resolve, reject) => signal.addEventListener("abort",
        () => reject(new InboxError("closed", "Synthetic cancelled request", 410)), { once: true }));
    },
  });
  const server = await startServer(inbox);
  start(inbox);
  await settle();
  await server.close();
  assert.equal(inbox.batch.snapshot(), null);
  assert.equal(client.threadReservations.size, 0);
  assert.equal(client.pendingThreads.size, 0);
  assert.equal(writes.length, 1);
  await assert.rejects(fetch(server.url));
});
