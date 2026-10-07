import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { GitHubClient, POLL_MS } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { InboxError, normalizeThreads } from "../src/model.mjs";
import { startServer } from "../src/server.mjs";
import { http, next, thread } from "./fixtures.mjs";

const ok = "HTTP/2 205 Reset Content\r\n\r\n";
const settle = () => new Promise(resolve => setImmediate(resolve));
const laterThread = id => thread(id, { updated_at: "2026-01-11T12:00:00Z" });

async function fixture({ rows = [thread("1"), thread("2"), thread("3")], run, sleep } = {}) {
  let now = 0;
  const writes = [];
  const waits = [];
  const client = new GitHubClient({
    now: () => now,
    sleep: sleep ?? (async delay => { waits.push(delay); now += delay; }),
    run: async (args, options) => {
      if (args.includes("PATCH")) writes.push(args.at(-1));
      return run ? run(args, options) : args.includes("PATCH") ? ok : http(rows, { etag: '"synthetic"' });
    },
  });
  const inbox = new Inbox(client);
  await inbox.refresh();
  return { inbox, client, writes, waits, advance: () => { now += POLL_MS; } };
}

function selection(inbox, repository = "example/widgets") {
  const group = inbox.snapshot().groups.find(group => group.repository === repository);
  return { repository, selectionKey: group.selectionKey };
}

function start(inbox, repository = "example/widgets") {
  inbox.batch.start(selection(inbox, repository));
  return { token: inbox.batch.snapshot().token };
}

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
      thread("3", { reason: "team_mention" }), thread("4", { reason: "mention", repository: { full_name: "example/other" } })],
  });
  await inbox.setFilters({ query: "notification 1" });
  const before = selection(inbox);
  await inbox.setFilters({ attention: "mentioned" });
  assert.equal(inbox.summary().matching, 1);
  assert.throws(() => inbox.batch.start(before), { code: "selection_changed" });
  start(inbox);
  await assert.rejects(inbox.setFilters({ attention: "all" }), { code: "busy" });
  await inbox.batch.done;
  assert.deepEqual(writes, ["/notifications/threads/1"]);
  assert.deepEqual(inbox.loadedItems().map(item => item.id), ["2", "3", "4"]);
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
  assert.equal(client.readReservations.size, 0);
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
  assert.equal(client.readReservations.size, 0);
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
    assert.equal(panel.summary().loaded, 0);
    assert.equal(panel.summary().needsRefresh, true);
  }
  assert.throws(() => inbox.batch.start(input), { code: "selection_changed" });
  assert.equal(writes.length, 3);
  assert.equal(client.readReservations.size, 0);
  client.run = async () => "HTTP/2 304 Not modified\r\n\r\n";
  advance();
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 0);
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
  assert.deepEqual(inbox.loadedItems().map(item => item.id).sort(), ["2", "4"]);
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
  await assert.rejects(inbox.setFilters({ query: "changed" }), { code: "busy" });
  await settle();
  await assert.rejects(other.markRead({ id: "1" }), { code: "busy" });
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

test("auth/rate/network failures stop the batch with exact partial counts and retry never repeats successes", async () => {
  for (const failure of [http({}, {}, 401), http({}, { "retry-after": "600" }, 429),
    new InboxError("gh_failed", "Synthetic connection failure")]) {
    let count = 0;
    let failing = true;
    const { inbox, client, writes } = await fixture({
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
    assert.equal(inbox.summary().loaded, 2);
    failing = false;
    client.blockedUntil = 0;
    inbox.batch.retry(token);
    assert.equal(inbox.batch.snapshot().status, "running");
    assert.equal(inbox.batch.snapshot().total, 2);
    assert.throws(() => inbox.batch.retry(token), { code: "busy" });
    await inbox.batch.done;
    assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/2", "/notifications/threads/3"]);
    assert.equal(inbox.summary().loaded, 0);
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
  assert.equal(inbox.loadedItems().some(item => item.id === "2"), false);
  assert.equal(inbox.summary().loaded, 2);
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
      assert.equal(client.readReservations.size, 0);
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
  assert.equal(client.readReservations.size, 0);
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
    assert.equal(client.readReservations.size, 0);
    assert.equal(client.pendingReads.size, 0);
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
  assert.equal(client.readReservations.size, 0);
  assert.equal(client.pendingReads.size, 0);
  assert.equal(writes.length, 1);
  await assert.rejects(fetch(server.url));
});
