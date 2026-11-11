import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { GitHubClient, POLL_MS } from "../src/provider/github.mjs";
import { Inbox } from "../src/provider/inbox.mjs";
import { InboxError, normalizeThreads } from "../src/shared/model.mjs";
import { startServer } from "../src/provider/server.mjs";
import { http, inboxNext as next, retrySelection, thread } from "./fixtures.mjs";

const ok = "HTTP/2 205 Reset Content\r\n\r\n";
const settle = () => new Promise(resolve => setImmediate(resolve));
const laterThread = id => thread(id, { updated_at: "2026-01-11T12:00:00Z" });

test("repository, date and shown batches intersect refinements and reject changed filter contexts", async t => {
  for (const scope of ["repository", "date", "shown"]) {
    for (const action of ["read", "done"]) {
      const { inbox, client, writes } = await fixture({ rows: [
        thread("1", { reason: "mention" }), thread("2"), thread("3", { unread: false }),
        thread("4", { subject: { title: "Synthetic issue", type: "Issue", url: null } }),
      ] });
      t.after(() => inbox.close());
      client.now = () => Date.parse("2026-01-20T12:00:00Z");
      const input = () => scope === "repository" ? { ...selection(inbox), action } :
        scope === "date" ? dateSelection(inbox, "2026-01-10", "UTC", action) :
        { scope, selectionKey: inbox.snapshot().selectionKey, action };
      await inbox.setFilters({ type: "PullRequest", readState: "unread", age: "older_7d" });
      const previous = input();
      await inbox.setFilters({ reason: "review_requested" });
      assert.throws(() => inbox.batch.start(previous), { code: "selection_changed" });
      const unchangedItems = input();
      await inbox.setFilters({ query: "Synthetic" });
      assert.throws(() => inbox.batch.start(unchangedItems), { code: "selection_changed" });
      inbox.batch.start(input());
      await inbox.batch.done;
      assert.deepEqual(writes, ["/notifications/threads/2"]);
      assert.deepEqual(inbox.loadedItems().filter(item => item.unread).map(item => item.id), ["1", "4"]);
    }
  }
});

test("an age cutoff crossing invalidates all batch scopes before any write", async t => {
  for (const scope of ["repository", "date", "shown"]) {
    const { inbox, client, writes } = await fixture({ rows: [thread("1"), laterThread("2")] });
    t.after(() => inbox.close());
    let now = Date.parse("2026-01-17T12:00:00Z");
    client.now = () => now;
    await inbox.setFilters({ age: "last_7d" });
    const snapshot = inbox.snapshot();
    const input = scope === "repository" ? selection(inbox) : scope === "date"
      ? dateSelection(inbox, "2026-01-10") : { scope, selectionKey: snapshot.selectionKey };
    now++;
    assert.equal(inbox.snapshot().matching, 1);
    assert.throws(() => inbox.batch.start(input), { code: "selection_changed" });
    assert.deepEqual(writes, []);
  }
});

test("retrying a refined batch excludes newly matching rows and waits for original rows to be shown", async t => {
  let fail = true;
  const rows = [thread("1", { reason: "mention" }), thread("2", { reason: "subscribed" })];
  const { inbox, writes, advance } = await fixture({ rows, run: args => args.includes("GET") ? http(rows) :
    fail ? http({}, {}, 403) : "HTTP/2 204 No Content\r\n\r\n" });
  t.after(() => inbox.close());
  await inbox.setFilters({ reason: "mention" });
  inbox.batch.start({ scope: "shown", selectionKey: inbox.snapshot().selectionKey, action: "done" });
  await inbox.batch.done;
  const token = inbox.batch.snapshot().token;
  await inbox.setFilters({ reason: "subscribed" });
  assert.throws(() => inbox.batch.retry(retrySelection(inbox, { token })), { code: "no_remaining" });
  fail = false;
  advance(120_000);
  await inbox.setFilters({ reason: "all" });
  inbox.batch.retry(retrySelection(inbox, { token }));
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/1"]);
  assert.deepEqual(inbox.loadedItems().map(item => item.id), ["2"]);
});

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

async function fixture({ rows = [thread("1"), thread("2"), thread("3")], run } = {}) {
  let now = 0;
  const writes = [];
  const methods = [];
  const waits = [];
  const client = new GitHubClient({
    now: () => now,
    sleep: async delay => { waits.push(delay); now += delay; },
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
    return [2, 3].includes(++attempts) ? http({}, {}, 500) : "HTTP/2 204 No Content\r\n\r\n";
  } });
  t.after(() => inbox.close());
  inbox.batch.start(dateSelection(inbox, "2026-01-12"));
  const token = { token: inbox.batch.snapshot().token };
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().succeeded, 1);
  assert.equal(inbox.batch.snapshot().failed, 2);
  inbox.pages[0].items.find(item => item.id === "2").updatedAt = "2026-01-13T11:00:00.000Z";
  inbox.pages[0].items.push(...normalizeThreads([thread("4", { updated_at: "2026-01-12T13:00:00Z", reason: "mention" })]));
  await inbox.setFilters({ attention: "mentioned" });
  assert.throws(() => inbox.batch.retry({ ...token, date: "2026-01-13" }), { code: "invalid_batch" });
  assert.throws(() => inbox.batch.retry({ ...token, timeZone: "Asia/Tokyo" }), { code: "invalid_batch" });
  advance();
  advance();
  inbox.batch.retry(retrySelection(inbox, token));
  assert.equal(inbox.batch.snapshot().date, "2026-01-12");
  assert.equal(inbox.batch.snapshot().timeZone, "UTC");
  assert.equal(inbox.batch.snapshot().scope, "date");
  assert.equal(inbox.batch.snapshot().action, "done");
  assert.equal(inbox.batch.snapshot().total, 1);
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/3", "/notifications/threads/3"]);
  assert.deepEqual(methods, ["DELETE", "DELETE", "DELETE", "DELETE"]);
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

test("Done batches issue DELETEs for only loaded attention and search matches and synchronize other panels", async t => {
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
  assert.deepEqual(waits, []);
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
    return ++deletes >= 2 && fail ? http({}, {}, 500) : "HTTP/2 204 No Content\r\n\r\n";
  } });
  t.after(() => inbox.close());
  const token = start(inbox, "example/widgets", "done");
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().action, "done");
  assert.equal(inbox.batch.snapshot().succeeded, 1);
  assert.equal(inbox.batch.snapshot().failed, 2);
  assert.equal(inbox.batch.snapshot().notAttempted, 0);
  inbox.pages[0].items.push(...normalizeThreads([thread("4")]));
  assert.throws(() => inbox.batch.retry({ ...token, action: "read" }), { code: "invalid_batch" });
  assert.throws(() => inbox.batch.retry(retrySelection(inbox, token)), { code: "github_http" });
  assert.equal(methods.length, 3);
  advance();
  advance();
  fail = false;
  inbox.batch.retry(retrySelection(inbox, token));
  assert.equal(inbox.batch.snapshot().action, "done");
  assert.equal(inbox.batch.snapshot().total, 2);
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/3", "/notifications/threads/2", "/notifications/threads/3"]);
  assert.deepEqual(methods, ["DELETE", "DELETE", "DELETE", "DELETE", "DELETE"]);
  assert.deepEqual(inbox.loadedItems().map(item => item.id), ["4"]);
  inbox.batch.start(selection(inbox));
  assert.equal(inbox.batch.snapshot().action, "read");
  await inbox.batch.done;
  assert.equal(methods.at(-1), "PATCH");
  assert.equal(client.threadReservations.size, 0);
});

test("Done rejects invalid actions and rechecks selected activity after waiting for a page", async t => {
  let release;
  const { inbox, client, writes } = await fixture();
  t.after(() => inbox.close());
  for (const action of [undefined, null, "", "DELETE", "unread", true, {}, []]) {
    assert.throws(() => inbox.batch.start({ ...selection(inbox), action }), { code: "invalid_selection" });
  }
  client.pageQueue = new Promise(resolve => { release = resolve; });
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

test("closing a Done batch cancels queued and in-flight work and releases all reservations", async () => {
  for (const queued of [true, false]) {
    const interrupted = signal => new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(new InboxError("closed", "Synthetic cancellation", 410)), { once: true }));
    const { inbox, client, methods } = await fixture({
      run: (args, { signal }) => args.includes("GET") ? http([thread("1"), thread("2")]) : interrupted(signal),
    });
    if (queued) client.pageQueue = new Promise(() => {});
    start(inbox, "example/widgets", "done");
    await settle();
    inbox.close();
    await inbox.batch.done;
    assert.equal(inbox.batch.snapshot(), null);
    assert.equal(client.pendingThreads.size, 0);
    assert.equal(client.threadReservations.size, 0);
    assert.deepEqual(methods, queued ? [] : ["DELETE", "DELETE"]);
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

test("one request captures only shown loaded search matches without fetching more pages", async () => {
  const rows = [thread("1"), thread("2"), thread("3", { repository: { full_name: "example/other" } })];
  const { inbox, writes } = await fixture({
    run: async args => args.includes("PATCH") ? ok : http(rows, { link: next }),
  });
  await inbox.setFilters({ query: "notification 1" });
  start(inbox);
  assert.equal(inbox.batch.snapshot().total, 1);
  assert.equal(inbox.batch.snapshot().searchActive, true);
  assert.equal(inbox.batch.snapshot().repository, "example/widgets");
  assert.equal(inbox.summary().hasMore, true);
  const summary = JSON.stringify(inbox.summary());
  assert.doesNotMatch(summary, /example\/|selectionKey|token/);
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot(), null);
  assert.deepEqual(writes, ["/notifications/threads/1"]);
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
  let failing = true;
  const { inbox, writes, advance } = await fixture({ run: args => args.includes("GET")
    ? http([thread("1", { reason: "mention" }), thread("2", { reason: "review_requested" })])
    : failing ? http({}, {}, 500) : ok });
  const token = start(inbox);
  await inbox.batch.done;
  await inbox.setFilters({ attention: "review_requested" });
  failing = false;
  advance(120_000);
  inbox.batch.retry(retrySelection(inbox, token));
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/2"]);
});

test("batch controls reject malformed, missing and stale operation tokens without changing the current selection", async () => {
  const { inbox, client, writes, advance } = await fixture({
    run: args => args.includes("GET") ? http([thread("1")]) : http({}, {}, 500),
  });
  const unknown = { token: "00000000-0000-4000-8000-000000000000" };
  for (const action of ["retry", "dismiss"]) {
    for (const input of [undefined, null, [], {}, { token: 1 }, { token: "invalid" }, { ...unknown, ids: ["1"] }]) {
      assert.throws(() => inbox.batch[action](input), { code: "invalid_batch" });
      assert.equal(inbox.batch.snapshot(), null);
    }
    assert.throws(() => inbox.batch[action](action === "retry" ? retrySelection(inbox, unknown) : unknown), { code: "unknown_batch" });
  }
  const stale = start(inbox);
  await inbox.batch.done;
  inbox.batch.dismiss(stale);
  advance(120_000);
  const current = start(inbox);
  await inbox.batch.done;
  assert.notEqual(current.token, stale.token);
  const before = inbox.batch.snapshot();
  for (const action of ["retry", "dismiss"]) {
    for (const input of [stale, unknown]) {
      assert.throws(() => inbox.batch[action](action === "retry" ? retrySelection(inbox, input) : input), { code: "unknown_batch" });
      assert.deepEqual(inbox.batch.snapshot(), before);
    }
  }
  assert.equal(inbox.summary().loaded, 1);
  assert.equal(client.threadReservations.size, 0);
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/1"]);
});

test("dismissal is blocked during a batch and clears failed progress without changing unread rows", async () => {
  const { inbox, client, writes } = await fixture({
    run: args => args.includes("GET") ? http([thread("1")]) : http({}, {}, 500),
  });
  const token = start(inbox);
  assert.throws(() => inbox.batch.dismiss(token), { code: "busy" });
  assert.equal(inbox.batch.snapshot().token, token.token);
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().status, "partial");
  inbox.batch.dismiss(token);
  assert.equal(inbox.batch.snapshot(), null);
  assert.throws(() => inbox.batch.dismiss(token), { code: "unknown_batch" });
  assert.equal(inbox.summary().loaded, 1);
  assert.equal(inbox.summary().unread, 1);
  assert.equal(client.threadReservations.size, 0);
  assert.deepEqual(writes, ["/notifications/threads/1"]);
});

test("group size is bounded by loaded rows, not an arbitrary silent cap or an oversized HTTP ID array", async () => {
  const { inbox } = await fixture({ rows: Array.from({ length: 2000 }, (_, index) => thread(String(index + 1))) });
  const group = inbox.groups()[0];
  const input = { repository: group.repository, selectionKey: group.selectionKey };
  assert.ok(JSON.stringify(input).length < 256);
  inbox.batch.start(input);
  assert.equal(inbox.batch.snapshot().total, 2000);
  inbox.close();
  await inbox.batch.done;
});

test("one-click batches make PATCH calls, update shared panels, and quietly clear completed state", async () => {
  const { inbox, client, writes, waits, advance } = await fixture();
  const other = new Inbox(client);
  await other.refresh();
  const input = selection(inbox);
  start(inbox);
  assert.throws(() => inbox.batch.start(input), { code: "busy" });
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot(), null);
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/3"]);
  assert.deepEqual(waits, []);
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

test("newer cache activity is rechecked after a queued page, before a PATCH is dispatched", async () => {
  let release;
  const { inbox, client, writes } = await fixture();
  client.pageQueue = new Promise(resolve => { release = resolve; });
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
  assert.throws(() => inbox.queueThread({ id: "1" }, "read"), { code: "busy" });
  assert.throws(() => inbox.queueThread({ id: "1" }, "done"), { code: "busy" });
  await inbox.setFilters({ query: "changed" });
  await inbox.setFilters({ mode: "unread" });
  await settle();
  assert.throws(() => other.queueThread({ id: "1" }, "read"), { code: "busy" });
  assert.throws(() => other.queueThread({ id: "1" }, "done"), { code: "busy" });
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
  inbox.queueThread({ id: "1" }, "read");
  assert.throws(() => start(inbox), { code: "busy" });
  await settle();
  release();
  await inbox.batch.done;
});

test("disjoint batches and rows run together with isolated failures, retries, and shared reservations", async t => {
  let release;
  let failing = true;
  const rows = [
    thread("1"), thread("2"), thread("6", { unread: false }),
    thread("3", { repository: { full_name: "example/other" } }),
    thread("4", { repository: { full_name: "example/other" } }),
    thread("5", { repository: { full_name: "example/solo" } }),
  ];
  const { inbox, client, writes, methods, advance } = await fixture({ run: async args => {
    if (args.includes("GET")) return http(rows);
    if (args.at(-1).endsWith("/1")) await new Promise(resolve => { release = resolve; });
    if (failing && /\/[34]$/.test(args.at(-1))) return http({}, {}, 500);
    return args.includes("DELETE") ? "HTTP/2 204 No Content\r\n\r\n" : ok;
  } });
  const other = new Inbox(client);
  t.after(() => { release?.(); inbox.close(); other.close(); });
  await other.refresh();
  const first = start(inbox);
  inbox.queueThread({ id: "5" }, "done");
  const second = start(inbox, "example/other", "done");
  assert.equal(inbox.batch.snapshots().length, 3);
  assert.equal(inbox.batch.locked, true);
  assert.deepEqual(new Set(inbox.snapshot().lockedThreadIds), new Set(["1", "2", "3", "4", "5", "6"]));
  assert.deepEqual(new Set(other.snapshot().lockedThreadIds), new Set(["1", "2", "3", "4", "5", "6"]));
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /example\/|token|selectionKey|lockedThreadIds|remainingThreadIds|snapshotVersion|Synthetic notification/);
  assert.throws(() => start(other, "example/other"), { code: "busy" });
  assert.throws(() => inbox.queueThread({ id: "6" }, "done"), { code: "busy" });
  assert.throws(() => other.queueThread({ id: "2" }, "done"), { code: "busy" });
  await settle();
  assert.equal(inbox.batch.snapshots().find(batch => batch.token === first.token).status, "running");
  release();
  await inbox.batch.done;
  inbox.batch.acknowledge(String(inbox.snapshot().snapshotVersion));
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/5",
    "/notifications/threads/3", "/notifications/threads/4"]);
  assert.deepEqual(methods, ["PATCH", "PATCH", "DELETE", "DELETE", "DELETE"]);
  assert.equal(inbox.batch.snapshot().token, second.token);
  assert.equal(inbox.batch.snapshot().status, "partial");
  assert.equal(inbox.batch.snapshot().failed, 2);
  assert.equal(client.threadReservations.size, 0);
  failing = false;
  advance(120_000);
  inbox.batch.retry(retrySelection(inbox, second));
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
      await inbox.setFilters({ mode: "unread" });
      assert.deepEqual(inbox.batch.snapshot(), before);
      release();
      await inbox.batch.done;
      assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2"]);
      assert.deepEqual(methods, [action === "done" ? "DELETE" : "PATCH", action === "done" ? "DELETE" : "PATCH"]);
      assert.equal(inbox.groups()[0].items[0].id, "3");
    }
  }
});

test("queued row failures remain visible until retry or refresh, and closing cancels queued rows", async t => {
  const { inbox, client, advance } = await fixture({ run: args => args.includes("GET")
    ? http([thread("1"), thread("2")]) : http({}, {}, 500) });
  t.after(() => inbox.close());
  const token = inbox.queueThread({ id: "1" }, "done");
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().token, token);
  assert.equal(inbox.batch.snapshot().scope, "thread");
  assert.equal(inbox.batch.snapshot().error.code, "github_http");
  advance(120_000);
  await inbox.refresh({ force: true });
  assert.equal(inbox.batch.snapshot(), null);
  const started = [];
  client.run = (args, { signal }) => {
    started.push(args.at(-1));
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Synthetic shutdown")), { once: true }));
  };
  inbox.queueThread({ id: "1" }, "read");
  inbox.queueThread({ id: "2" }, "done");
  await settle();
  inbox.close();
  await inbox.batch.done;
  assert.deepEqual(started, ["/notifications/threads/1", "/notifications/threads/2"]);
  assert.equal(client.pendingThreads.size, 0);
  assert.equal(client.threadReservations.size, 0);
  assert.equal(client.threadWrites.size, 0);
  assert.deepEqual(inbox.batch.snapshots(), []);
});

test("successful writes clear only that thread's stale failures in every panel", async t => {
  for (const otherPanel of [false, true]) {
    for (const action of ["read", "done"]) {
      let fail = true;
      const { inbox, client, advance } = await fixture({ run: args => args.includes("GET")
        ? http([thread("1"), thread("2")]) : fail ? http({}, {}, 500) : args.includes("DELETE") ? "HTTP/2 204 No Content\r\n\r\n" : ok });
      const other = new Inbox(client);
      t.after(() => { inbox.close(); other.close(); });
      await other.refresh();
      const stale = inbox.queueThread({ id: "1" }, "done");
      await inbox.batch.done;
      advance(120_000);
      const unrelated = inbox.queueThread({ id: "2" }, "done");
      await inbox.batch.done;
      advance(120_000);
      fail = false;
      const writer = otherPanel ? other : inbox;
      if (otherPanel) {
        writer.queueThread({ id: "1" }, action);
        await writer.batch.done;
      }
      else {
        await writer.setFilters({ query: "notification 1" });
        start(writer, "example/widgets", action);
        await writer.batch.done;
      }
      assert.equal(inbox.batch.operations.has(stale), false);
      assert.equal(inbox.batch.operations.has(unrelated), true);
      assert.deepEqual(inbox.snapshot().batches.map(batch => batch.threadId), ["2"]);
    }
  }
});

test("completed row receipts survive lost snapshots and refreshes until their rendered version is acknowledged", async t => {
  const { inbox } = await fixture();
  t.after(() => inbox.close());
  const before = inbox.snapshot();
  const token = inbox.queueThread({ id: "1" }, "done");
  await inbox.batch.done;
  inbox.batch.acknowledge(String(before.snapshotVersion));
  assert.equal(inbox.batch.operations.has(token), true, "an undisclosed outcome cannot be acknowledged");
  const completed = inbox.snapshot();
  assert.equal(completed.batches[0].status, "completed");
  inbox.batch.acknowledge(String(before.snapshotVersion));
  await inbox.setFilters({ query: "missing" });
  await inbox.refresh({ force: true });
  assert.equal(inbox.batch.operations.has(token), true);
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /token|threadId|resultVersion|Synthetic|example\//);
  assert.equal(inbox.summary().batch, null);
  assert.deepEqual(inbox.summary().batches, []);
  inbox.batch.acknowledge(String(completed.snapshotVersion));
  assert.equal(inbox.batch.operations.has(token), false);
  inbox.batch.acknowledge(String(completed.snapshotVersion));
  assert.deepEqual(inbox.snapshot().batches, []);
});

test("a snapshot shares retry indexes across large failed batches and computes each batch once", async t => {
  const rows = Array.from({ length: 1000 }, (_, index) => thread(String(index + 1), {
    repository: { full_name: index < 500 ? "example/widgets" : "example/other" },
  }));
  const { inbox, client, advance } = await fixture({ run: args => args.includes("GET") ? http(rows) : http({}, {}, 500) });
  t.after(() => inbox.close());
  start(inbox);
  await inbox.batch.done;
  advance(120_000);
  start(inbox, "example/other");
  await inbox.batch.done;
  const loaded = t.mock.method(inbox, "loadedItems");
  const groups = t.mock.method(inbox, "groups");
  const cache = t.mock.method(client.cache, "values");
  const snapshots = t.mock.method(inbox.batch, "snapshot");
  const state = inbox.snapshot();
  assert.deepEqual(state.batches.map(batch => batch.retryableThreadIds.length), [500, 500]);
  assert.equal(state.batch, state.batches.at(-1));
  assert.equal(loaded.mock.callCount(), 1);
  assert.equal(groups.mock.callCount(), 1);
  assert.equal(cache.mock.callCount(), 1);
  assert.equal(snapshots.mock.callCount(), 2);
  client.cache.set("newer-synthetic-page", {
    sequence: inbox.pages[0].sequence + 1,
    items: normalizeThreads([thread("1", { unread: false })]),
  });
  assert.deepEqual(inbox.snapshot().batches.map(batch => batch.retryableThreadIds.length), [499, 500],
    "the next snapshot must rebuild indexes after a newer cached response");
});

test("protected snapshots distinguish queued rows from dispatched writes without leaking identities in summaries", async t => {
  const releases = [];
  const { inbox, client } = await fixture({ run: args => args.includes("GET") ? http([thread("1"), thread("2")]) :
    new Promise(resolve => { releases.push(() => resolve(args.includes("PATCH") ? ok : "HTTP/2 204 No Content\r\n\r\n")); }),
  });
  t.after(() => { releases.forEach(release => release()); inbox.close(); });
  inbox.queueThread({ id: "1" }, "read");
  const read = inbox.batch.done;
  inbox.queueThread({ id: "2" }, "done");
  assert.deepEqual(inbox.snapshot().threadWrites, [
    { id: "1", action: "read", inFlight: false }, { id: "2", action: "done", inFlight: false },
  ]);
  await settle();
  const old = inbox.snapshot();
  assert.deepEqual(old.threadWrites.map(write => write.inFlight), [true, true]);
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /threadWrites|"id"|lockedThreadIds/);
  releases[0]();
  await read;
  await settle();
  assert.deepEqual(inbox.snapshot().threadWrites, [{ id: "2", action: "done", inFlight: true }]);
  assert.equal(old.threadWrites[1].inFlight, true);
  releases[1]();
  await inbox.batch.done;
  assert.equal(client.threadWrites.size, 0);
});

test("dismissing a failed result and closing active batches affect only their own operations", async t => {
  let entered;
  const dispatched = new Promise(resolve => { entered = resolve; });
  let failing = true;
  const { inbox, client, advance } = await fixture({ run: (args, { signal }) => {
    if (args.includes("GET")) return http([thread("1"), thread("2", { repository: { full_name: "example/other" } })]);
    if (failing) return http({}, {}, 500);
    entered();
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  } });
  t.after(() => inbox.close());
  const failed = start(inbox);
  await inbox.batch.done;
  failing = false;
  advance(120_000);
  const active = start(inbox, "example/other");
  await dispatched;
  inbox.batch.dismiss(failed);
  assert.equal(inbox.batch.snapshot().token, active.token);
  assert.throws(() => inbox.batch.retry(retrySelection(inbox, active)), { code: "busy" });
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
      { succeeded: 2, failed: 1, skipped: 0, notAttempted: 0 });
    assert.equal(writes.length, 3);
    assert.equal(inbox.summary().loaded, 3);
    assert.equal(inbox.summary().unread, 1);
    failing = false;
    advance(client.blockedUntil - client.now());
    inbox.batch.retry(retrySelection(inbox, token));
    assert.equal(inbox.batch.snapshot().status, "running");
    assert.equal(inbox.batch.snapshot().total, 1);
    assert.throws(() => inbox.batch.retry(retrySelection(inbox, token)), { code: "unknown_batch" });
    await inbox.batch.done;
    assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/3", "/notifications/threads/2"]);
    assert.equal(inbox.summary().loaded, 3);
    assert.equal(inbox.summary().unread, 0);
  }
});

test("retry keeps the old selection and respects a newly narrowed search", async () => {
  let writes = 0;
  const { inbox, client } = await fixture({
    run: async args => !args.includes("PATCH") ? http([thread("1"), thread("2"), thread("3")]) :
      ++writes <= 3 ? http({}, {}, 500) : ok,
  });
  const token = start(inbox);
  await inbox.batch.done;
  await inbox.setFilters({ query: "notification 2" });
  client.blockedUntil = 0;
  inbox.batch.retry(retrySelection(inbox, token));
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
      assert.throws(() => inbox.batch.retry(retrySelection(inbox, token)), { code: "no_remaining" });
      assert.deepEqual(inbox.batch.snapshot(), before);
      assert.equal(inbox.summary().loaded, 1);
      assert.equal(client.threadReservations.size, 0);
      assert.deepEqual(writes, ["/notifications/threads/1"]);
    });
  }
});

test("closing a batch ignores late confirmations and sends no remaining requests", async t => {
  const releases = [];
  const { inbox, writes, client } = await fixture({
    run: async args => args.includes("PATCH") ? new Promise(resolve => { releases.push(() => resolve(ok)); }) :
      http(Array.from({ length: 11 }, (_, i) => thread(String(i + 1)))),
  });
  const other = new Inbox(client);
  t.after(() => other.close());
  await other.refresh();
  start(inbox);
  await settle();
  assert.equal(inbox.batch.snapshot().inFlight, true);
  inbox.close();
  releases.forEach(release => release());
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot(), null);
  assert.equal(other.summary().unread, 11);
  assert.equal(client.revision, 0);
  assert.equal(writes.length, 10);
  assert.equal(client.threadReservations.size, 0);
});

test("closing a panel while waiting for a page aborts not-yet-dispatched work", async () => {
  const { inbox, client, writes } = await fixture();
  client.pageQueue = new Promise(() => {});
  start(inbox);
  await settle();
  inbox.close();
  await inbox.batch.done;
  assert.equal(writes.length, 0);
  assert.equal(client.threadReservations.size, 0);
  assert.equal(client.pendingThreads.size, 0);
  assert.equal(inbox.batch.snapshot(), null);
});

test("unexpected transport errors become explicit partial results", async () => {
  const broken = await fixture({ run: async args => {
    if (args.includes("PATCH")) throw new Error("secret internal context");
    return http([thread("1"), thread("2")]);
  } });
  start(broken.inbox);
  await broken.inbox.batch.done;
  assert.equal(broken.inbox.batch.snapshot().failed, 2);
  assert.equal(broken.inbox.batch.snapshot().notAttempted, 0);
  assert.doesNotMatch(JSON.stringify(broken.inbox.batch.snapshot()), /secret internal/);
});

test("HTTP start returns before writes finish, status stays readable and the removed Stop endpoint returns 404", async t => {
  const releases = [];
  const { inbox, writes } = await fixture({
    run: async args => args.includes("PATCH") ? new Promise(resolve => { releases.push(() => resolve(ok)); }) : http([thread("1"), thread("2")]),
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
  assert.equal((await post("cancel", token)).status, 404);
  assert.equal(inbox.batch.snapshot().status, "running");
  releases.forEach(release => release());
  await inbox.batch.done;
  assert.equal(writes.length, 2);
  const source = await readFile(new URL("../src/extension.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /name: "(?:mark_read|batch|bulk|prepare|start_batch)"/);
});

test("existing backoff prevents starting, and quota exhaustion after success leaves the rest not attempted", async () => {
  const { inbox, client, writes } = await fixture({
    run: async args => args.includes("PATCH") ?
      http(null, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999" }, 205) :
      http(Array.from({ length: 12 }, (_, i) => thread(String(i + 1)))),
  });
  client.blockedUntil = 1000;
  assert.throws(() => start(inbox), { code: "rate_limited" });
  assert.equal(inbox.batch.snapshot(), null);
  client.blockedUntil = 0;
  start(inbox);
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().succeeded, 10);
  assert.equal(inbox.batch.snapshot().failed, 0);
  assert.equal(inbox.batch.snapshot().notAttempted, 2);
  assert.equal(inbox.batch.snapshot().error.code, "rate_limited");
  assert.equal(writes.length, 10);
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
  assert.equal(writes.length, 2);
  await assert.rejects(fetch(server.url));
});
