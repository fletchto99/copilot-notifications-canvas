import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, POLL_MS } from "../.github/extensions/github-notifications/github.mjs";
import { Inbox } from "../.github/extensions/github-notifications/inbox.mjs";
import { startServer } from "../.github/extensions/github-notifications/server.mjs";
import { http, next, thread } from "./fixtures.mjs";

const empty = status => `HTTP/2 ${status} Synthetic\r\n\r\n`;

test("205 and documented 304 confirmation remove the known row and synchronize shared panels without a sound event", async () => {
  for (const status of [205, 304]) {
    const calls = [];
    const client = new GitHubClient({ run: async args => {
      calls.push(args);
      return args.includes("PATCH") ? empty(status) : http([thread()], { etag: '"before"' });
    } });
    const one = new Inbox(client);
    const two = new Inbox(client);
    await one.refresh();
    await two.refresh();
    await one.markRead({ id: "1" });
    for (const inbox of [one, two]) {
      assert.equal(inbox.summary().loaded, 0);
      assert.equal(inbox.summary().activity.sequence, 0);
      assert.equal(inbox.summary().needsRefresh, true);
    }
    const write = calls.find(args => args.includes("PATCH"));
    assert.equal(write.at(-1), "/notifications/threads/1");
    assert.equal(write.includes("If-None-Match"), false);
    assert.equal(client.cache.values().next().value.etag, undefined);
  }
});

test("failed HTTP/auth/rate/network mutations retain rows and counts", async () => {
  for (const result of [empty(401), empty(403), empty(429), empty(500), new Error("network")]) {
    const client = new GitHubClient({ run: async args => {
      if (!args.includes("PATCH")) return http([thread()]);
      if (result instanceof Error) {
        const { InboxError } = await import("../.github/extensions/github-notifications/model.mjs");
        throw new InboxError("gh_failed", "Synthetic connection failure");
      }
      return result;
    } });
    const inbox = new Inbox(client);
    await inbox.refresh();
    await assert.rejects(inbox.markRead({ id: "1" }));
    assert.equal(inbox.summary().loaded, 1);
    assert.equal(inbox.summary().activity.sequence, 0);
  }
});

test("unknown or malformed IDs and duplicate pending clicks cannot issue writes", async () => {
  let release;
  let writes = 0;
  const client = new GitHubClient({ run: async args => {
    if (!args.includes("PATCH")) return http([thread()]);
    writes++;
    await new Promise(resolve => { release = resolve; });
    return empty(205);
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  for (const input of [null, {}, { id: "../1" }, { id: 1 }, { id: "1", extra: true }, { id: "999" }]) {
    await assert.rejects(inbox.markRead(input));
  }
  const first = inbox.markRead({ id: "1" });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(inbox.markRead({ id: "1" }), { code: "busy" });
  assert.equal(inbox.summary().loaded, 1);
  release();
  await first;
  assert.equal(writes, 1);
});

test("writes share the request queue and use a one-second spacing, not the GET polling cooldown", async () => {
  let now = 0;
  const waits = [];
  const client = new GitHubClient({
    now: () => now,
    sleep: async delay => { waits.push(delay); now += delay; },
    run: async args => args.includes("PATCH") ? empty(205) : http([thread("1"), thread("2")]),
  });
  const inbox = new Inbox(client);
  await inbox.refresh();
  await Promise.all([inbox.markRead({ id: "1" }), inbox.markRead({ id: "2" })]);
  assert.deepEqual(waits, [1000]);
  assert.equal(inbox.summary().loaded, 0);
});

test("cached/304 pages cannot resurrect reads; later real activity can reappear, and pagination requires reconciliation", async () => {
  let now = Date.parse("2026-01-10T12:00:00Z");
  let phase = "initial";
  const calls = [];
  const client = new GitHubClient({ now: () => now, run: async args => {
    calls.push(args);
    if (args.includes("PATCH")) return empty(205);
    if (phase === "unchanged") return empty(304);
    return http([thread("1", { updated_at: new Date(now).toISOString() })], { etag: '"value"', link: next });
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  await inbox.markRead({ id: "1" });
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 0);
  await assert.rejects(inbox.more(), { code: "refresh_required" });
  phase = "unchanged";
  now += POLL_MS;
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 0);
  assert.equal(calls.at(-1).some(arg => arg.startsWith("If-")), false);
  phase = "new";
  now += POLL_MS;
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 1);
  assert.equal(inbox.summary().activity.sequence, 1);
});

test("HTTP mark-read routes authorize known IDs and leave mutations out of agent actions", async t => {
  let writes = 0;
  const inbox = new Inbox(new GitHubClient({ run: async args => {
    if (!args.includes("PATCH")) return http([thread()]);
    writes++;
    return empty(205);
  } }));
  await inbox.refresh();
  const server = await startServer(inbox);
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  for (const [override, input, status] of [
    [{ Authorization: "wrong" }, { id: "1" }, 403],
    [{ Origin: "https://evil.test" }, { id: "1" }, 403],
    [{}, { id: "1/../2" }, 400],
    [{}, { id: "999" }, 404],
    [{}, { id: "1" }, 200],
  ]) {
    const response = await fetch(`${url.origin}/api/read`, { method: "POST", headers: { ...headers, ...override }, body: JSON.stringify(input) });
    assert.equal(response.status, status);
  }
  assert.equal(writes, 1);
});

test("a mark in another panel during a multi-page refresh cannot resurrect a read row or advance sound", async () => {
  let now = 0;
  let slow = false;
  let release;
  const client = new GitHubClient({ now: () => now, run: async args => {
    if (args.includes("PATCH")) return empty(205);
    if (slow && args.at(-1).includes("page=1")) await new Promise(resolve => { release = resolve; });
    return args.at(-1).includes("page=1") ? http([thread("1")], { link: next }) : http([thread("2")]);
  } });
  const one = new Inbox(client);
  const two = new Inbox(client);
  await one.refresh();
  await one.more();
  await two.refresh();
  slow = true;
  now = POLL_MS;
  const refresh = one.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const read = two.markRead({ id: "1" });
  release();
  await read;
  await assert.rejects(refresh, { code: "inbox_changed" });
  assert.equal(one.snapshot().groups.flatMap(group => group.items).some(item => item.id === "1"), false);
  assert.equal(one.summary().activity.sequence, 0);
});

test("rate-limited writes block subsequent writes until GitHub's retry time", async () => {
  let writes = 0;
  const client = new GitHubClient({ now: () => 0, sleep: async () => {}, run: async args => {
    if (!args.includes("PATCH")) return http([thread("1"), thread("2")]);
    writes++;
    return http({}, { "retry-after": "600" }, 429);
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  await assert.rejects(inbox.markRead({ id: "1" }), { code: "rate_limited" });
  await assert.rejects(inbox.markRead({ id: "2" }), { code: "rate_limited" });
  assert.equal(writes, 1);
  assert.equal(inbox.summary().loaded, 2);
});
