import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { GitHubClient, POLL_MS } from "../.github/extensions/github-notifications/github.mjs";
import { Inbox } from "../.github/extensions/github-notifications/inbox.mjs";
import { InboxError, normalizeThreads } from "../.github/extensions/github-notifications/model.mjs";
import { startServer } from "../.github/extensions/github-notifications/server.mjs";
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

function prepare(inbox, repository = "example/widgets") {
  const group = inbox.snapshot().groups.find(group => group.repository === repository);
  inbox.batch.prepare({ repository, selectionKey: group.selectionKey });
  return { token: inbox.batch.snapshot().token };
}

test("confirmation captures only the shown loaded search matches and cancellation makes zero writes", async () => {
  const rows = [thread("1"), thread("2"), thread("3", { repository: { full_name: "example/other" } })];
  const { inbox, writes } = await fixture({
    run: async args => args.includes("PATCH") ? ok : http(rows, { link: next }),
  });
  await inbox.setFilters({ query: "notification 1" });
  const token = prepare(inbox);
  assert.equal(inbox.batch.snapshot().total, 1);
  assert.equal(inbox.batch.snapshot().searchActive, true);
  assert.equal(inbox.batch.snapshot().repository, "example/widgets");
  assert.equal(inbox.summary().hasMore, true);
  const summary = JSON.stringify(inbox.summary());
  assert.doesNotMatch(summary, /example\/|selectionKey|token/);
  inbox.batch.cancel(token);
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot(), null);
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
    assert.throws(() => inbox.batch.prepare(input));
  }
  await inbox.setFilters({ query: "notification 1" });
  assert.throws(() => inbox.batch.prepare({ repository: group.repository, selectionKey: group.selectionKey }),
    { code: "selection_changed" });
  for (const input of [{}, { token: 1 }, { token: "a".repeat(36) }, { token: "a".repeat(36), ids: ["1"] }]) {
    assert.throws(() => inbox.batch.start(input));
  }
  assert.deepEqual(writes, []);
});

test("group size is bounded by loaded rows, not an arbitrary silent cap or an oversized HTTP ID array", async () => {
  const { inbox } = await fixture({ rows: Array.from({ length: 2000 }, (_, index) => thread(String(index + 1))) });
  const group = inbox.groups()[0];
  const input = { repository: group.repository, selectionKey: group.selectionKey };
  assert.ok(JSON.stringify(input).length < 256);
  inbox.batch.prepare(input);
  assert.equal(inbox.batch.snapshot().total, 2000);
  inbox.batch.cancel({ token: inbox.batch.snapshot().token });
});

test("confirmed batches make spaced sequential per-thread PATCH calls, update shared panels, and never sound", async () => {
  const { inbox, client, writes, waits, advance } = await fixture();
  const other = new Inbox(client);
  await other.refresh();
  const token = prepare(inbox);
  inbox.batch.start(token);
  inbox.batch.start(token);
  await inbox.batch.done;
  const result = inbox.batch.snapshot();
  assert.equal(result.status, "completed");
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed + result.skipped + result.notAttempted, 0);
  assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/3"]);
  assert.deepEqual(waits, [1000, 1000]);
  for (const panel of [inbox, other]) {
    assert.equal(panel.summary().loaded, 0);
    assert.equal(panel.summary().needsRefresh, true);
    assert.equal(panel.summary().activity.sequence, 0);
  }
  inbox.batch.start(token);
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
  assert.equal(inbox.summary().activity.sequence, 1);
});

test("a prepared selection excludes new arrivals and skips changed or no-longer-loaded captured rows", async () => {
  const { inbox, writes } = await fixture();
  const token = prepare(inbox);
  inbox.pages = [{ ...inbox.pages[0], items: normalizeThreads([thread("1"), laterThread("2"), thread("4")]) }];
  inbox.batch.start(token);
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
  const token = prepare(inbox);
  client.writeAvailableAt = 1000;
  inbox.batch.start(token);
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
  const token = prepare(inbox);
  assert.throws(() => prepare(inbox), { code: "busy" });
  await assert.rejects(inbox.markRead({ id: "1" }), { code: "busy" });
  await assert.rejects(inbox.setFilters({ query: "changed" }), { code: "busy" });
  inbox.batch.start(token);
  await settle();
  await assert.rejects(other.markRead({ id: "1" }), { code: "busy" });
  const otherToken = prepare(other);
  assert.throws(() => other.batch.start(otherToken), { code: "busy" });
  other.batch.cancel(otherToken);
  release();
  await inbox.batch.done;
  assert.equal(writes.length, 1);
});

test("preparation cannot overlap a previously issued per-row mutation", async () => {
  let release;
  const { inbox } = await fixture({
    run: async args => args.includes("PATCH") ? new Promise(resolve => { release = () => resolve(ok); }) : http([thread("1")]),
  });
  const pending = inbox.markRead({ id: "1" });
  assert.throws(() => prepare(inbox), { code: "busy" });
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
    const token = prepare(inbox);
    inbox.batch.start(token);
    await inbox.batch.done;
    assert.deepEqual(
      (({ succeeded, failed, skipped, notAttempted }) => ({ succeeded, failed, skipped, notAttempted }))(inbox.batch.snapshot()),
      { succeeded: 1, failed: 1, skipped: 0, notAttempted: 1 });
    assert.equal(writes.length, 2);
    assert.equal(inbox.summary().loaded, 2);
    assert.equal(inbox.summary().activity.sequence, 0);
    failing = false;
    client.blockedUntil = 0;
    inbox.batch.retry(token);
    assert.equal(inbox.batch.snapshot().status, "prepared");
    assert.equal(inbox.batch.snapshot().total, 2);
    inbox.batch.start({ token: inbox.batch.snapshot().token });
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
  const token = prepare(inbox);
  inbox.batch.start(token);
  await inbox.batch.done;
  await inbox.setFilters({ query: "notification 2" });
  client.blockedUntil = 0;
  inbox.batch.retry(token);
  assert.equal(inbox.batch.snapshot().total, 1);
  inbox.batch.start({ token: inbox.batch.snapshot().token });
  await inbox.batch.done;
  assert.equal(inbox.loadedItems().some(item => item.id === "2"), false);
  assert.equal(inbox.summary().loaded, 2);
});

test("cancellation while a request is in flight waits for its confirmation but sends no remaining requests", async () => {
  let release;
  const { inbox, writes, client } = await fixture({
    run: async args => args.includes("PATCH") ? new Promise(resolve => { release = () => resolve(ok); }) : http([thread("1"), thread("2")]),
  });
  const token = prepare(inbox);
  inbox.batch.start(token);
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
    const token = prepare(inbox);
    inbox.batch.start(token);
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

test("prepare expires without writing and unexpected transport errors become explicit partial results", async () => {
  const { inbox, advance, writes } = await fixture();
  const token = prepare(inbox);
  for (let n = 0; n < 3; n++) advance();
  assert.throws(() => inbox.batch.start(token), { code: "confirmation_expired" });
  inbox.batch.cancel(token);
  assert.equal(writes.length, 0);
  const broken = await fixture({ run: async args => {
    if (args.includes("PATCH")) throw new Error("secret internal context");
    return http([thread("1"), thread("2")]);
  } });
  broken.inbox.batch.start(prepare(broken.inbox));
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
  assert.equal((await post("prepare", selection, { Origin: "https://evil.test" })).status, 403);
  assert.equal((await post("prepare", selection, { Authorization: "wrong" })).status, 403);
  assert.equal((await post("prepare", { ...selection, ids: ["1", "1"] })).status, 400);
  assert.equal((await fetch(`${url.origin}/api/batch/start`, { headers })).status, 405);
  const prepared = await post("prepare", selection);
  const token = { token: (await prepared.json()).batch.token };
  const started = await post("start", token);
  assert.equal(started.status, 202);
  assert.equal((await started.json()).batch.status, "running");
  const progress = await fetch(`${url.origin}/api/state`, { headers });
  assert.equal((await progress.json()).batch.inFlight, true);
  assert.equal((await post("start", token)).status, 202);
  const cancelling = await post("cancel", token);
  assert.equal((await cancelling.json()).batch.status, "stopping");
  release();
  await inbox.batch.done;
  assert.equal(writes.length, 1);
  const source = await readFile(new URL("../.github/extensions/github-notifications/extension.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /name: "(?:mark_read|batch|bulk|prepare|start_batch)"/);
});

test("existing backoff prevents starting, and quota exhaustion after success leaves the rest not attempted", async () => {
  const { inbox, client, writes } = await fixture({
    run: async args => args.includes("PATCH") ?
      http(null, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999" }, 205) :
      http([thread("1"), thread("2"), thread("3")]),
  });
  const token = prepare(inbox);
  client.blockedUntil = 1000;
  assert.throws(() => inbox.batch.start(token), { code: "rate_limited" });
  assert.equal(inbox.batch.snapshot().status, "prepared");
  client.blockedUntil = 0;
  inbox.batch.start(token);
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
  inbox.batch.start(prepare(inbox));
  await settle();
  await server.close();
  assert.equal(inbox.batch.snapshot(), null);
  assert.equal(client.readReservations.size, 0);
  assert.equal(client.pendingReads.size, 0);
  assert.equal(writes.length, 1);
  await assert.rejects(fetch(server.url));
});
