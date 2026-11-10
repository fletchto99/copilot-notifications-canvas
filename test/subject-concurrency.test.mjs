import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, firstPage } from "../src/provider/github.mjs";
import { InboxError, normalizeThreads } from "../src/shared/model.mjs";
import { http, thread } from "./fixtures.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
const items = (count, start = 1) => normalizeThreads(Array.from({ length: count }, (_, index) => {
  const id = String(start + index);
  return thread(id, { subject: {
    type: "Issue", title: `Synthetic issue ${id}`, url: `https://api.github.com/repos/example/widgets/issues/${id}`,
  } });
}));

function fixture() {
  const calls = [];
  const releases = new Map();
  let active = 0;
  let maximum = 0;
  const client = new GitHubClient({ run: async (args, { signal }) => {
    const path = args.at(-1);
    if (path.startsWith("/notifications?")) return http([]);
    if (args.includes("PATCH")) return "HTTP/2 205 Synthetic\r\n\r\n";
    calls.push(path);
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve, reject) => {
        const aborted = () => reject(new InboxError("closed", "The canvas was closed.", 410));
        signal?.addEventListener("abort", aborted, { once: true });
        releases.set(path, () => {
          signal?.removeEventListener("abort", aborted);
          resolve();
        });
      });
      return http({ state: "closed" });
    } finally {
      releases.delete(path);
      active--;
    }
  } });
  return {
    client, calls, releases,
    get active() { return active; },
    get maximum() { return maximum; },
    async drain() {
      while (releases.size) {
        for (const release of releases.values()) release();
        await settle();
      }
    },
  };
}

test("twenty status requests run concurrently across panels and free slots keep making progress", async () => {
  const f = fixture();
  const first = f.client.refreshSubjects(items(40));
  await settle();
  assert.equal(f.active, 20);
  assert.deepEqual(f.calls, items(20).map(item => `/repos/example/widgets/issues/${item.number}`));
  const second = f.client.refreshSubjects(items(25, 41));
  await settle();
  assert.equal(f.active, 20);
  assert.equal(f.calls.length, 20);
  f.releases.get(f.calls[1])();
  await settle();
  assert.equal(f.calls.length, 21, "A slow first row must not block a free slot");
  assert.equal(f.active, 20);
  await f.drain();
  await Promise.all([first, second]);
  assert.equal(f.maximum, 20);
  assert.equal(f.calls.length, 65);
  assert.equal(new Set(f.calls).size, 65);
  assert.equal(f.client.subjectWorkers.size, 0);
  assert.equal(f.client.subjectRequests.size, 0);
  assert.equal(f.client.subjectWaiters.size, 0);
  assert.equal(f.client.subjectRefreshes.size, 0);
});

test("overlapping panels deduplicate in-flight lookups and reuse the completed cache", async () => {
  const f = fixture();
  const all = items(25);
  const first = f.client.refreshSubjects(all);
  const second = f.client.refreshSubjects(all);
  await settle();
  assert.ok(f.active > 1);
  await f.drain();
  await Promise.all([first, second]);
  assert.ok(f.maximum <= 20);
  assert.equal(f.calls.length, 25);
  assert.equal(new Set(f.calls).size, 25);
  await f.client.refreshSubjects(all);
  assert.equal(f.calls.length, 25);
});

test("inbox reads and triage do not wait for outstanding status lookups", async () => {
  const f = fixture();
  const loading = f.client.refreshSubjects(items(25));
  await settle();
  assert.equal(f.active, 20);
  assert.equal((await f.client.page(firstPage())).items.length, 0);
  await f.client.markRead("1");
  assert.equal(f.active, 20);
  await f.drain();
  await loading;
});

test("closing a panel cancels slot and duplicate waiters without cancelling another panel", { timeout: 5000 }, async () => {
  for (const count of [1, 20]) {
    const f = fixture();
    const first = f.client.refreshSubjects(items(count));
    await settle();
    const controller = new AbortController();
    const second = f.client.refreshSubjects(items(count), controller.signal);
    const rejected = assert.rejects(second, { code: "closed" });
    await settle();
    controller.abort();
    await rejected;
    assert.equal(f.active, count, "The original panel's requests are still running");
    await f.drain();
    await first;
    assert.equal(f.calls.length, count);
    assert.equal(f.client.subjectWorkers.size, 0);
    assert.equal(f.client.subjectRequests.size, 0);
  }
});

test("closing a panel aborts its in-flight work and never dispatches the remaining rows", async () => {
  const f = fixture();
  const controller = new AbortController();
  const loading = f.client.refreshSubjects(items(25), controller.signal);
  const rejected = assert.rejects(loading, { code: "closed" });
  await settle();
  assert.equal(f.active, 20);
  controller.abort();
  await rejected;
  await settle();
  assert.equal(f.calls.length, 20);
  assert.equal(f.active, 0);
  assert.equal(f.client.subjectWorkers.size, 0);
  assert.equal(f.client.subjectCache.size, 0);
});

test("an unexpected lookup failure stops queued rows and waits for in-flight work", async () => {
  const f = fixture();
  const original = f.client.run;
  f.client.run = async (...args) => {
    await original(...args);
    throw new Error("Synthetic unexpected lookup failure");
  };
  const loading = f.client.refreshSubjects(items(25));
  const rejected = assert.rejects(loading, /Synthetic unexpected lookup failure/);
  await settle();
  f.releases.get(f.calls[0])();
  await settle();
  assert.equal(f.calls.length, 20);
  assert.equal(f.active, 19);
  await f.drain();
  await rejected;
  assert.equal(f.calls.length, 20);
  assert.equal(f.client.subjectWorkers.size, 0);
});

test("aborted requests retain their slots until the transport finishes stopping", async () => {
  const f = fixture();
  const original = f.client.run;
  f.client.run = args => original(args, {});
  const controller = new AbortController();
  const first = f.client.refreshSubjects(items(20), controller.signal);
  const rejected = assert.rejects(first, { code: "closed" });
  await settle();
  assert.equal(f.active, 20);
  controller.abort();
  const second = f.client.refreshSubjects(items(20, 21));
  await settle();
  assert.equal(f.calls.length, 20, "New requests must wait until the aborted transports stop");
  await f.drain();
  await Promise.all([rejected, second]);
  assert.equal(f.maximum, 20);
  assert.equal(f.calls.length, 40);
});

test("shared slots serve waiting callers before a large selection reclaims them", async () => {
  const f = fixture();
  const first = f.client.refreshSubjects(items(80));
  await settle();
  const second = f.client.refreshSubjects(items(1, 81));
  const third = f.client.refreshSubjects(items(1, 82));
  await settle();
  try {
    f.releases.get(f.calls[0])();
    await settle();
    assert.equal(f.calls[20], "/repos/example/widgets/issues/81");
    f.releases.get(f.calls[1])();
    await settle();
    assert.equal(f.calls[21], "/repos/example/widgets/issues/82");
  } finally {
    await f.drain();
    await Promise.all([first, second, third]);
  }
});

test("a stable live selection computes subject keys linearly rather than for every membership check", async () => {
  const all = items(500);
  let reads = 0;
  for (const item of all) {
    const repository = item.repository;
    Object.defineProperty(item, "repository", { get() { reads++; return repository; } });
  }
  const client = new GitHubClient({ run: async () => http({ state: "closed" }) });
  await client.refreshSubjects(() => all);
  assert.ok(reads < all.length * 40, `${reads} repository reads for ${all.length} rows`);
});

test("aborting a FIFO waiter removes it without consuming the next released slot", async () => {
  const f = fixture();
  const first = f.client.refreshSubjects(items(80));
  await settle();
  const controller = new AbortController();
  const second = f.client.refreshSubjects(items(1, 81), controller.signal);
  const rejected = assert.rejects(second, { code: "closed" });
  const third = f.client.refreshSubjects(items(1, 82));
  await settle();
  controller.abort();
  await rejected;
  assert.equal(f.client.subjectWaiters.size, 1);
  try {
    f.releases.get(f.calls[0])();
    await settle();
    assert.equal(f.calls[20], "/repos/example/widgets/issues/82");
  } finally {
    await f.drain();
    await Promise.all([first, third]);
  }
  assert.equal(f.client.subjectWaiters.size, 0);
});
