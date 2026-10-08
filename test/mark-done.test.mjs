import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubClient, POLL_MS } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { InboxError } from "../src/model.mjs";
import { Preferences } from "../src/settings.mjs";
import { startServer } from "../src/server.mjs";
import { http, next, thread } from "./fixtures.mjs";

const confirmed = "HTTP/2 204 No Content\r\n\r\n";
const settle = () => new Promise(resolve => setImmediate(resolve));

test("Done uses DELETE and a 204 confirmation synchronizes loaded panels without exposing notification details", async t => {
  const calls = [];
  const client = new GitHubClient({ run: async args => {
    calls.push(args);
    return args.includes("DELETE") ? confirmed : http([thread("1"), thread("2")], {
      etag: '"before"', "last-modified": "Sat, 10 Jan 2026 12:00:00 GMT", link: next,
    });
  } });
  const one = new Inbox(client);
  const two = new Inbox(client);
  t.after(() => { one.close(); two.close(); });
  await one.refresh();
  await two.refresh();
  const summary = await one.markDone({ id: "1" });
  assert.equal(summary.loaded, 1);
  assert.equal(summary.unread, 1);
  assert.doesNotMatch(JSON.stringify(summary), /Synthetic notification|example\/widgets|doneHistory/);
  for (const inbox of [one, two]) {
    assert.deepEqual(inbox.loadedItems().map(item => item.id), ["2"]);
    assert.equal(inbox.summary().needsRefresh, true);
    await assert.rejects(inbox.more(), { code: "refresh_required" });
  }
  const write = calls.find(args => args.includes("DELETE"));
  assert.equal(write.at(-1), "/notifications/threads/1");
  assert.equal(write[write.indexOf("--hostname") + 1], "github.com");
  assert.equal(write.some(arg => arg.startsWith("If-")), false);
  assert.equal(calls.some(args => args.includes("PATCH") || args.includes("PUT")), false);
  assert.equal(client.cache.values().next().value.etag, undefined);
  assert.equal(client.cache.values().next().value.modified, undefined);
  assert.equal(client.revision, 1);
});

test("only 204 confirms Done; failed or ambiguous responses retain the row and release the pending write", async t => {
  for (const status of [200, 202, 205, 304, 401, 403, 404, 429, 500, "network"]) {
    const client = new GitHubClient({ run: async args => {
      if (!args.includes("DELETE")) return http([thread()]);
      if (status === "network") throw new InboxError("gh_failed", "Synthetic connection failure");
      return http({}, {}, status);
    } });
    const inbox = new Inbox(client);
    t.after(() => inbox.close());
    await inbox.refresh();
    await assert.rejects(inbox.markDone({ id: "1" }));
    assert.equal(inbox.summary().loaded, 1);
    assert.equal(inbox.summary().needsRefresh, false);
    assert.equal(client.revision, 0);
    assert.equal(client.pendingThreads.size, 0);
    assert.equal(inbox.marking.size, 0);
  }
});

test("Done rejects malformed, unloaded and already-read thread IDs before issuing a write", async t => {
  const calls = [];
  const client = new GitHubClient({ run: async args => {
    calls.push(args);
    return http([thread("1"), thread("2", { unread: false })]);
  } });
  const inbox = new Inbox(client);
  t.after(() => inbox.close());
  await inbox.refresh();
  for (const input of [null, [], {}, { id: 1 }, { id: "0" }, { id: "01" }, { id: "../1" },
    { id: "1", extra: true }, { id: "9".repeat(65) }]) {
    await assert.rejects(inbox.markDone(input), { code: "invalid_thread" });
  }
  for (const id of ["2", "999"]) await assert.rejects(inbox.markDone({ id }), { code: "unknown_thread" });
  assert.throws(() => client.markDone("../1"), { code: "invalid_thread" });
  assert.equal(calls.length, 1);
});

test("read and Done clicks share duplicate protection across panels and block overlapping batches", async t => {
  for (const action of ["markRead", "markDone"]) {
    const writes = [];
    let finish;
    const client = new GitHubClient({ run: async args => {
      if (args.includes("GET")) return http([thread()]);
      writes.push(args);
      await new Promise(resolve => { finish = resolve; });
      return args.includes("DELETE") ? confirmed : "HTTP/2 205 Reset Content\r\n\r\n";
    } });
    const one = new Inbox(client);
    const two = new Inbox(client);
    t.after(() => { one.close(); two.close(); });
    await one.refresh();
    await two.refresh();
    const pending = one[action]({ id: "1" });
    await settle();
    for (const inbox of [one, two]) {
      await assert.rejects(inbox.markRead({ id: "1" }), { code: "busy" });
      await assert.rejects(inbox.markDone({ id: "1" }), { code: "busy" });
      const { repository, selectionKey } = inbox.groups()[0];
      assert.throws(() => inbox.batch.start({ repository, selectionKey }), { code: "busy" });
    }
    finish();
    await pending;
    assert.equal(writes.length, 1);
    assert.equal(client.pendingThreads.size, 0);
  }
});

test("Done cannot take a later thread reserved by another panel's repository read batch", async t => {
  let finish;
  const client = new GitHubClient({ run: async args => {
    if (args.includes("GET")) return http([thread("1"), thread("2")]);
    assert.ok(args.includes("PATCH"));
    await new Promise(resolve => { finish = resolve; });
    return "HTTP/2 205 Reset Content\r\n\r\n";
  } });
  const one = new Inbox(client);
  const two = new Inbox(client);
  t.after(() => { one.close(); two.close(); });
  await one.refresh();
  await two.refresh();
  const { repository, selectionKey } = one.groups()[0];
  one.batch.start({ repository, selectionKey });
  await settle();
  await assert.rejects(two.markDone({ id: "2" }), { code: "busy" });
  one.batch.cancel({ token: one.batch.snapshot().token });
  finish();
  await one.batch.done;
  assert.equal(client.threadReservations.size, 0);
});

test("Done shares write spacing and rate backoff with reads without automatic retries", async t => {
  let now = 0;
  const waits = [];
  const methods = [];
  const client = new GitHubClient({
    now: () => now,
    sleep: async delay => { waits.push(delay); now += delay; },
    run: async args => {
      const method = args[args.indexOf("--method") + 1];
      if (method === "GET") return http([thread("1"), thread("2"), thread("3"), thread("4")]);
      methods.push(method);
      if (methods.length === 3) return http({}, { "retry-after": "600" }, 429);
      return method === "DELETE" ? confirmed : "HTTP/2 205 Reset Content\r\n\r\n";
    },
  });
  const inbox = new Inbox(client);
  t.after(() => inbox.close());
  await inbox.refresh();
  await inbox.markDone({ id: "1" });
  await inbox.markRead({ id: "2" });
  await assert.rejects(inbox.markDone({ id: "3" }), { code: "rate_limited" });
  await assert.rejects(inbox.markRead({ id: "4" }), { code: "rate_limited" });
  assert.deepEqual(methods, ["DELETE", "PATCH", "DELETE"]);
  assert.deepEqual(waits, [1000, 1000, 1000]);
  assert.deepEqual(inbox.loadedItems().map(item => item.id), ["3", "4"]);
});

test("Done invalidates cached pages without hiding new unread activity behind a local completion ledger", async t => {
  let now = 0;
  let response = http([thread()], { etag: '"initial"' });
  const client = new GitHubClient({ now: () => now, run: async args => args.includes("DELETE") ? confirmed : response });
  const inbox = new Inbox(client);
  t.after(() => inbox.close());
  await inbox.refresh();
  await inbox.markDone({ id: "1" });
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 0);
  now += POLL_MS;
  response = "HTTP/2 304 Not Modified\r\n\r\n";
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 0);
  now += POLL_MS;
  response = http([thread("1", { updated_at: "2026-01-11T12:00:00Z" })]);
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 1);
});

test("Done during another panel's multi-page refresh cannot resurrect the completed row", async t => {
  let now = 0;
  let finish;
  const client = new GitHubClient({ now: () => now, run: async args => {
    if (args.includes("DELETE")) return confirmed;
    if (now && args.at(-1).includes("page=1")) await new Promise(resolve => { finish = resolve; });
    return args.at(-1).includes("page=1") ? http([thread("1")], { link: next }) : http([thread("2")]);
  } });
  const one = new Inbox(client);
  const two = new Inbox(client);
  t.after(() => { one.close(); two.close(); });
  await one.refresh();
  await one.more();
  await two.refresh();
  now = POLL_MS;
  const refresh = one.refresh();
  await settle();
  const done = two.markDone({ id: "1" });
  const rejected = assert.rejects(refresh, { code: "inbox_changed" });
  finish();
  await done;
  await rejected;
  assert.deepEqual(one.loadedItems().map(item => item.id), ["2"]);
});

test("closing a panel cancels queued and in-flight Done actions without confirming an unknown outcome", async () => {
  for (const inFlight of [false, true]) {
    let finish;
    let writes = 0;
    const client = new GitHubClient({ run: async args => {
      if (args.includes("GET")) return http([thread()]);
      writes++;
      await new Promise(resolve => { finish = resolve; });
      return confirmed;
    } });
    const inbox = new Inbox(client);
    await inbox.refresh();
    const done = inbox.markDone({ id: "1" });
    const rejected = assert.rejects(done, { code: "closed" });
    if (inFlight) await settle();
    inbox.close();
    finish?.();
    await rejected;
    assert.equal(writes, Number(inFlight));
    assert.equal(client.revision, 0);
    assert.equal(client.pendingThreads.size, 0);
    assert.equal(client.threadListeners.size, 0);
    assert.equal(inbox.summary().loaded, 0);
  }
});

test("the protected Done route requires an explicit same-origin POST and persists no completion state", async t => {
  const directory = await mkdtemp(join(tmpdir(), "notification-done-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preferences = new Preferences({ directory });
  await preferences.update({ groupBy: "date" });
  const filesBefore = await readdir(directory);
  const settingsBefore = await readFile(join(directory, "settings.json"), "utf8");
  const writes = [];
  const logs = [];
  const inbox = new Inbox(new GitHubClient({ run: async args => {
    if (args.includes("GET")) return http([thread()]);
    writes.push(args);
    return confirmed;
  } }));
  await inbox.refresh();
  const server = await startServer(inbox, { preferences, log: message => logs.push(message), development: null });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  for (const [method, override, body, status] of [
    ["GET", {}, undefined, 405],
    ["DELETE", {}, undefined, 405],
    ["POST", { Authorization: "wrong" }, '{"id":"1"}', 403],
    ["POST", { Origin: "" }, '{"id":"1"}', 403],
    ["POST", { Origin: "https://evil.test" }, '{"id":"1"}', 403],
    ["POST", { "Sec-Fetch-Site": "cross-site" }, '{"id":"1"}', 403],
    ["POST", { "Content-Type": "text/plain" }, '{"id":"1"}', 415],
    ["POST", {}, "{", 400],
    ["POST", {}, JSON.stringify({ id: "1", extra: true }), 400],
    ["POST", {}, '{"id":"999"}', 404],
    ["POST", {}, '{"id":"1"}', 200],
  ]) {
    const response = await fetch(`${url.origin}/api/done`, { method, headers: { ...headers, ...override }, body });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(writes.length, 1);
  assert.ok(writes[0].includes("DELETE"));
  assert.equal(writes[0].at(-1), "/notifications/threads/1");
  assert.deepEqual(logs, []);
  assert.deepEqual(await readdir(directory), filesBefore);
  assert.equal(await readFile(join(directory, "settings.json"), "utf8"), settingsBefore);
});
