import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, firstPage } from "../src/provider/github.mjs";
import { Inbox } from "../src/provider/inbox.mjs";
import { InboxError } from "../src/shared/model.mjs";
import { http, retrySelection, thread } from "./fixtures.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
const confirmed = method => http(null, {}, method === "DELETE" ? 204 : 205);

async function fixture(t, firstCount = 15, secondCount = 15) {
  const rows = Array.from({ length: firstCount + secondCount }, (_, index) =>
    thread(String(index + 1), { repository: { full_name: index < firstCount ? "example/first" : "example/second" } }));
  const calls = [];
  const releases = new Map();
  let now = 0;
  let active = 0;
  let maximum = 0;
  const client = new GitHubClient({
    now: () => now,
    sleep: async () => assert.fail("Writes must not impose artificial spacing"),
    run: async (args, { signal }) => {
      if (args.includes("GET")) return http(rows);
      const id = args.at(-1).split("/").at(-1);
      const method = args[args.indexOf("--method") + 1];
      calls.push({ id, method });
      active++;
      maximum = Math.max(maximum, active);
      let abort;
      try {
        return await new Promise((resolve, reject) => {
          abort = () => reject(new InboxError("closed", "Synthetic cancellation", 410));
          signal?.addEventListener("abort", abort, { once: true });
          releases.set(id, (response = confirmed(method)) => response instanceof Error ? reject(response) : resolve(response));
        });
      } finally {
        signal?.removeEventListener("abort", abort);
        releases.delete(id);
        active--;
      }
    },
  });
  const first = new Inbox(client);
  const second = new Inbox(client);
  t.after(async () => {
    first.close();
    second.close();
    await Promise.all([first.batch.done, second.batch.done]);
  });
  await first.refresh();
  await second.refresh();
  return {
    client, first, second, calls, releases,
    get active() { return active; },
    get maximum() { return maximum; },
    advance() { now = client.blockedUntil; },
    start(inbox, repository, action) {
      const group = inbox.groups().find(group => group.repository === repository);
      inbox.batch.start({ repository, selectionKey: group.selectionKey, action });
      return { token: inbox.batch.snapshot().token };
    },
    async drain() {
      while (releases.size) {
        for (const release of releases.values()) release();
        await settle();
      }
    },
  };
}

test("Read and Done share ten slots across groups and panels and refill without waiting for a slow first row", async t => {
  const f = await fixture(t);
  f.start(f.first, "example/first", "read");
  f.start(f.second, "example/second", "done");
  await settle();
  assert.equal(f.active, 10);
  assert.equal(f.calls.length, 10);
  assert.equal(f.first.batch.snapshot().notAttempted, 5);
  assert.equal(f.second.batch.snapshot().notAttempted, 15);
  assert.equal(f.second.batch.snapshot().inFlight, false);
  assert.throws(() => f.second.queueThread({ id: "11" }, "done"), { code: "busy" });
  f.releases.get("2")();
  await settle();
  assert.equal(f.active, 10);
  assert.equal(f.calls.length, 11);
  assert.ok(f.releases.has("1"), "A slow first row is still running");
  assert.equal(f.first.batch.snapshot().succeeded, 1);
  assert.equal(f.first.batch.snapshot().notAttempted, 5);
  assert.equal(f.second.batch.snapshot().inFlight, true);
  assert.doesNotMatch(JSON.stringify(f.first.summary()), /example\/|Synthetic|threadWrites|"id"|selectionKey/);
  await f.drain();
  await Promise.all([f.first.batch.done, f.second.batch.done]);
  assert.equal(f.maximum, 10);
  assert.equal(f.calls.length, 30);
  assert.equal(new Set(f.calls.map(call => call.id)).size, 30);
  assert.deepEqual(f.calls.filter(call => call.method === "DELETE").map(call => call.id),
    Array.from({ length: 15 }, (_, i) => String(i + 16)));
  for (const inbox of [f.first, f.second]) {
    assert.equal(inbox.loadedItems().length, 15);
    assert.equal(inbox.loadedItems().filter(item => item.unread).length, 0);
    assert.equal(inbox.batch.snapshot(), null);
  }
  assert.equal(f.client.writeWorkers.size, 0);
  assert.equal(f.client.writeWaiters.size, 0);
  assert.equal(f.client.threadReservations.size, 0);
  assert.equal(f.client.pendingThreads.size, 0);
});

test("parallel failures stop unsent work, retain late successes and backoff, and retry only unfinished targets", async t => {
  for (const action of ["read", "done"]) {
    const f = await fixture(t);
    const token = f.start(f.first, "example/first", action);
    await settle();
    f.releases.get("2")(http({}, { "retry-after": "600" }, 429));
    await settle();
    assert.equal(f.calls.length, 10);
    assert.equal(f.first.batch.snapshot().status, "running");
    assert.equal(f.first.batch.snapshot().failed, 1);
    assert.equal(f.first.batch.snapshot().notAttempted, 5);
    assert.throws(() => f.first.batch.retry(retrySelection(f.first, token)), { code: "busy" });
    await f.drain();
    await f.first.batch.done;
    const stopped = f.first.batch.snapshot();
    assert.equal(stopped.succeeded, 9);
    assert.equal(stopped.failed, 1);
    assert.equal(stopped.notAttempted, 5);
    assert.equal(stopped.status, "partial");
    assert.equal(f.client.lastError.code, "rate_limited", "Late successes must not erase a concurrent failure");
    assert.equal(f.client.blockedUntil, 600_000);
    assert.throws(() => f.first.batch.retry(retrySelection(f.first, token)), { code: "rate_limited" });
    assert.throws(() => f.start(f.second, "example/second", "done"), { code: "rate_limited" });
    f.advance();
    f.first.batch.retry(retrySelection(f.first, token));
    assert.equal(f.first.batch.snapshot().action, action);
    assert.equal(f.first.batch.snapshot().total, 6);
    await settle();
    await f.drain();
    await f.first.batch.done;
    assert.deepEqual(f.calls.slice(10).map(call => call.id), ["2", "11", "12", "13", "14", "15"]);
    assert.equal(f.first.batch.snapshot(), null);
  }
});

test("unexpected errors stop a parallel batch without exposing details or dispatching remaining targets", async t => {
  const f = await fixture(t);
  f.start(f.first, "example/first", "done");
  await settle();
  f.releases.get("3")(new Error("private transport detail"));
  await settle();
  await f.drain();
  await f.first.batch.done;
  assert.equal(f.calls.length, 10);
  assert.equal(f.first.batch.snapshot().succeeded, 9);
  assert.equal(f.first.batch.snapshot().failed, 1);
  assert.equal(f.first.batch.snapshot().notAttempted, 5);
  assert.equal(f.first.batch.snapshot().error.code, "batch_failed");
  assert.doesNotMatch(JSON.stringify(f.first.summary()), /private transport detail/);
});

test("a failed batch removes its slot waiters but lets its sent requests finish independently of another panel", async t => {
  const f = await fixture(t, 8, 12);
  f.start(f.first, "example/first", "read");
  f.start(f.second, "example/second", "done");
  await settle();
  assert.equal(f.client.writeWaiters.size, 8);
  f.releases.get("9")(new Error("Synthetic transport failure"));
  await settle();
  assert.equal(f.client.writeWaiters.size, 0);
  assert.equal(f.active, 9);
  assert.equal(f.second.batch.snapshot().status, "running");
  assert.equal(f.second.batch.snapshot().inFlight, true);
  assert.equal(f.second.batch.snapshot().notAttempted, 10);
  f.releases.get("10")();
  await f.second.batch.done;
  assert.equal(f.second.batch.snapshot().status, "partial");
  assert.equal(f.second.batch.snapshot().succeeded, 1);
  assert.equal(f.second.batch.snapshot().failed, 1);
  assert.equal(f.second.batch.snapshot().error.code, "batch_failed");
  assert.equal(f.second.batch.snapshot().notAttempted, 10);
  assert.equal(f.active, 8);
  assert.equal(f.client.threadReservations.size, 8);
  await f.drain();
  await f.first.batch.done;
  assert.equal(f.calls.length, 10);
});

test("closing a panel cancels its queued and active writes without cancelling another panel", async t => {
  for (const firstCount of [8, 10]) {
    const f = await fixture(t, firstCount, 12);
    f.start(f.first, "example/first", "read");
    f.start(f.second, "example/second", "done");
    await settle();
    f.second.close();
    await f.second.batch.done;
    assert.equal(f.active, firstCount);
    assert.equal(f.client.writeWaiters.size, 0);
    assert.equal(f.client.pendingThreads.size, firstCount);
    assert.equal(f.client.threadReservations.size, firstCount);
    assert.deepEqual(f.second.batch.snapshots(), []);
    await f.drain();
    await f.first.batch.done;
    assert.equal(f.calls.length, 10);
  }
});

test("an inbox page waits for every earlier write, including after a failure, and gates later writes", async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const releases = new Map();
    const client = new GitHubClient({ run: args => new Promise(resolve => {
      const key = args.at(-1);
      calls.push(key);
      releases.set(key, resolve);
    }) });
    const read = client.markRead("1");
    const done = client.markDone("2");
    const readResult = fail ? assert.rejects(read, { code: "github_http" }) : read;
    const page = client.page(firstPage());
    const pageResult = fail ? assert.rejects(page, { code: "github_http" }) : page;
    const later = client.markDone("3");
    const laterResult = fail ? assert.rejects(later, { code: "github_http" }) : later;
    await settle();
    assert.equal(calls.length, 2);
    releases.get("/notifications/threads/1")(fail ? http({}, {}, 500) : confirmed("PATCH"));
    await readResult;
    await settle();
    assert.equal(calls.length, 2, "One settled write must not release the page barrier");
    releases.get("/notifications/threads/2")(confirmed("DELETE"));
    await done;
    await settle();
    if (!fail) {
      assert.equal(calls.length, 3, "The later write must still wait for the page");
      releases.get(calls[2])(http([]));
      await pageResult;
      await settle();
      assert.equal(calls.at(-1), "/notifications/threads/3");
      releases.get("/notifications/threads/3")(confirmed("DELETE"));
    }
    await Promise.all([pageResult, laterResult, client.queue]);
    assert.equal(calls.length, fail ? 2 : 4);
    assert.equal(client.writeWorkers.size, 0);
  }
});

test("writes recheck stale selections after waiting for a shared slot and never add new arrivals", async t => {
  const f = await fixture(t, 10, 2);
  f.start(f.first, "example/first", "read");
  f.start(f.second, "example/second", "done");
  await settle();
  assert.equal(f.client.writeWaiters.size, 2);
  for (const page of f.client.cache.values()) {
    page.items = page.items.map(item => item.id === "11" ? { ...item, updatedAt: "2026-01-11T12:00:00Z" } : item);
  }
  f.second.pages[0].items.push({ ...f.second.loadedItems().at(-1), id: "13" });
  await f.drain();
  await Promise.all([f.first.batch.done, f.second.batch.done]);
  assert.deepEqual(f.calls.map(call => call.id), [...Array.from({ length: 10 }, (_, i) => String(i + 1)), "12"]);
  assert.equal(f.second.batch.snapshot().skipped, 1);
  assert.equal(f.second.batch.snapshot().succeeded, 1);
  assert.equal(f.client.threadReservations.size, 0);
});

test("successful recovery with exhausted quota clears an old error without ignoring the new rate limit", async () => {
  let now = 0;
  let response = http({}, {}, 500);
  const client = new GitHubClient({ now: () => now, run: async () => response });
  await assert.rejects(client.markRead("1"), { code: "github_http" });
  now = client.blockedUntil;
  response = http(null, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "999" }, 204);
  await client.markDone("2");
  await assert.rejects(client.markDone("3"), { code: "rate_limited" });
  await settle();
  assert.equal(client.writeWorkers.size, 0);
});
