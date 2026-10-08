import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubClient } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { InboxError, normalizeThreads } from "../src/model.mjs";
import { Preferences } from "../src/settings.mjs";
import { startServer } from "../src/server.mjs";
import { http, next, thread } from "./fixtures.mjs";

const confirmed = method => `HTTP/2 ${method === "DELETE" ? 204 : 205} Synthetic\r\n\r\n`;
const settle = () => new Promise(resolve => setImmediate(resolve));
const rows = [
  thread("1", { repository: { full_name: "example/alpha" }, reason: "mention", updated_at: "2026-01-13T12:00:00Z" }),
  thread("2", { repository: { full_name: "example/beta" }, reason: "team_mention", updated_at: "2026-01-12T12:00:00Z" }),
  thread("3", { repository: { full_name: "example/gamma" }, reason: "assign", updated_at: "2026-01-11T12:00:00Z" }),
];

async function fixture({ items = rows, run, sleep } = {}) {
  let now = 0;
  const calls = [];
  const writes = [];
  const waits = [];
  const client = new GitHubClient({
    now: () => now,
    sleep: sleep ?? (async delay => { waits.push(delay); now += delay; }),
    run: async (args, options) => {
      const method = args[args.indexOf("--method") + 1];
      const endpoint = args.at(-1);
      calls.push({ method, endpoint });
      if (method !== "GET") {
        const match = /^\/notifications\/threads\/([1-9]\d*)$/.exec(endpoint);
        assert.ok(match, "Writes must target individual notification threads");
        assert.ok(["PATCH", "DELETE"].includes(method));
        writes.push({ method, id: match[1] });
      }
      return run ? run(args, options) : method === "GET" ? http(items) : confirmed(method);
    },
  });
  const inbox = new Inbox(client);
  await inbox.refresh();
  return { inbox, client, calls, writes, waits, advance: (milliseconds = 120_000) => { now += milliseconds; } };
}

function selection(inbox, action = "done") {
  return { scope: "shown", selectionKey: inbox.snapshot().selectionKey, action };
}

test("shown read and Done batches capture only loaded filter matches across repositories in newest-first order", async t => {
  for (const action of ["read", "done"]) {
    const pageOne = [
      ...rows,
      thread("4", { reason: "mention", subject: { type: "Issue", title: "Excluded", url: null } }),
    ];
    const pageTwo = [thread("5", { reason: "mention", updated_at: "2026-01-14T12:00:00Z" })];
    const { inbox, client, calls, writes, waits } = await fixture({ run: async args => {
      const method = args[args.indexOf("--method") + 1];
      if (method !== "GET") return confirmed(method);
      return args.at(-1).includes("page=2") ? http(pageTwo, { link: next.replace("page=2", "page=3") }) : http(pageOne, { link: next });
    } });
    const other = new Inbox(client);
    t.after(() => { inbox.close(); other.close(); });
    await inbox.more();
    await other.refresh();
    await other.more();
    await inbox.setFilters({ attention: "mentioned", query: "notification" });
    const input = selection(inbox, action);
    assert.match(input.selectionKey, /^[a-f0-9]{64}$/);
    inbox.batch.start(input);
    assert.equal(inbox.batch.snapshot().scope, "shown");
    assert.equal(inbox.batch.snapshot().repository, null);
    assert.equal(inbox.batch.snapshot().total, 3);
    assert.equal(inbox.batch.snapshot().action, action);
    assert.doesNotMatch(JSON.stringify(inbox.summary()), /selectionKey|"token"|example\/|Synthetic notification|"items"/);
    await inbox.batch.done;
    assert.deepEqual(writes, ["5", "1", "2"].map(id => ({ id, method: action === "done" ? "DELETE" : "PATCH" })));
    assert.deepEqual(waits, [1000, 1000]);
    assert.equal(calls.filter(call => call.method === "GET").length, 2);
    for (const panel of [inbox, other]) {
      assert.deepEqual(panel.loadedItems().map(item => item.id), ["3", "4"]);
      assert.equal(panel.summary().hasMore, true);
      assert.equal(panel.summary().needsRefresh, true);
    }
    assert.equal(client.threadReservations.size, 0);
  }
});

test("shown selection keys bind scope, filters, and repository identity and never reach agent summaries", async t => {
  const { inbox, writes } = await fixture({ items: [rows[0]] });
  t.after(() => inbox.close());
  const key = inbox.snapshot().selectionKey;
  const group = inbox.groups()[0];
  assert.throws(() => inbox.batch.start({ scope: "shown", selectionKey: group.selectionKey }), { code: "selection_changed" });
  assert.throws(() => inbox.batch.start({ repository: group.repository, selectionKey: key }), { code: "selection_changed" });
  for (const input of [
    null, {}, { scope: "all", selectionKey: key }, { scope: "shown", selectionKey: key, repository: group.repository },
    { scope: "shown", selectionKey: key, ids: ["1"] }, { scope: "shown", selectionKey: key, action: "DELETE" },
    { scope: "shown", selectionKey: null },
  ]) assert.throws(() => inbox.batch.start(input), { code: "invalid_selection" });
  await inbox.setFilters({ attention: "mentioned" });
  assert.notEqual(inbox.snapshot().selectionKey, key);
  assert.throws(() => inbox.batch.start({ scope: "shown", selectionKey: key }), { code: "selection_changed" });
  const previous = selection(inbox);
  inbox.pages[0].items[0].repository = "example/moved";
  assert.throws(() => inbox.batch.start(previous), { code: "selection_changed" });
  await inbox.setFilters({ query: "no matches" });
  assert.throws(() => inbox.batch.start(selection(inbox)), { code: "invalid_selection" });
  assert.equal(Object.hasOwn(inbox.summary(), "selectionKey"), false);
  assert.deepEqual(writes, []);
});

test("shown batches still default to read and can be cancelled before dispatch", async t => {
  const { inbox, writes } = await fixture();
  t.after(() => inbox.close());
  inbox.batch.start({ scope: "shown", selectionKey: inbox.snapshot().selectionKey });
  assert.equal(inbox.batch.snapshot().action, "read");
  inbox.batch.cancel({ token: inbox.batch.snapshot().token });
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().status, "cancelled");
  assert.equal(inbox.batch.snapshot().scope, "shown");
  assert.deepEqual(writes, []);
});

test("shown batches and repository or row writes cannot reserve overlapping threads in either direction", async t => {
  for (const first of ["shown", "repository", "row"]) {
    let release;
    const { inbox, client, writes } = await fixture({ run: async args => {
      const method = args[args.indexOf("--method") + 1];
      if (method === "GET") return http(rows.slice(0, 2));
      await new Promise(resolve => { release = resolve; });
      return confirmed(method);
    } });
    const other = new Inbox(client);
    t.after(() => { inbox.close(); other.close(); });
    await other.refresh();
    let pending;
    if (first === "row") pending = inbox.markRead({ id: "1" });
    else {
      const group = inbox.groups()[0];
      inbox.batch.start(first === "shown" ? selection(inbox) : {
        repository: group.repository, selectionKey: group.selectionKey,
      });
      pending = inbox.batch.done;
    }
    await settle();
    assert.throws(() => other.batch.start(selection(other)), { code: "busy" });
    assert.equal(other.batch.snapshot(), null);
    if (first === "shown") {
      const group = other.groups()[1];
      assert.throws(() => other.batch.start({ repository: group.repository, selectionKey: group.selectionKey }), { code: "busy" });
      await assert.rejects(other.markRead({ id: "2" }), { code: "busy" });
      await assert.rejects(other.markDone({ id: "2" }), { code: "busy" });
    }
    if (first !== "row") inbox.batch.cancel({ token: inbox.batch.snapshot().token });
    release();
    await pending;
    assert.equal(writes.length, 1);
    assert.equal(client.threadReservations.size, 0);
    assert.equal(client.pendingThreads.size, 0);
  }
});

test("shown retries keep their scope and action while excluding successes, new arrivals, and newly hidden items", async t => {
  let attempts = 0;
  const { inbox, client, writes, advance } = await fixture({ run: async args => {
    if (args.includes("GET")) return http(rows);
    return ++attempts === 2 ? http({}, {}, 500) : confirmed("DELETE");
  } });
  t.after(() => inbox.close());
  inbox.batch.start(selection(inbox));
  const token = { token: inbox.batch.snapshot().token };
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot().succeeded, 1);
  assert.equal(inbox.batch.snapshot().failed, 1);
  assert.equal(inbox.batch.snapshot().notAttempted, 1);
  assert.throws(() => inbox.batch.retry({ ...token, scope: "repository" }), { code: "invalid_batch" });
  assert.throws(() => inbox.batch.retry(token), { code: "github_http" });
  inbox.pages[0].items.push(...normalizeThreads([thread("30")]));
  await inbox.setFilters({ query: "notification 3" });
  advance();
  inbox.batch.retry(token);
  assert.equal(inbox.batch.snapshot().scope, "shown");
  assert.equal(inbox.batch.snapshot().action, "done");
  assert.equal(inbox.batch.snapshot().total, 1);
  await inbox.batch.done;
  assert.deepEqual(writes, ["1", "2", "3"].map(id => ({ method: "DELETE", id })));
  assert.deepEqual(inbox.loadedItems().map(item => item.id).sort(), ["2", "30"]);
  assert.equal(client.threadReservations.size, 0);
});

test("shown batches recheck repository identity after queued spacing and do not follow transferred threads", async t => {
  let release;
  const { inbox, client, writes } = await fixture({ sleep: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => inbox.close());
  client.writeAvailableAt = 1000;
  inbox.batch.start(selection(inbox));
  await settle();
  for (const page of client.cache.values()) {
    page.items = page.items.map(item => ({ ...item, repository: "example/transferred" }));
  }
  release();
  await inbox.batch.done;
  assert.deepEqual(writes, []);
  assert.equal(inbox.batch.snapshot().skipped, 3);
  assert.equal(client.threadReservations.size, 0);
});

test("closing a shown batch aborts in-flight work without keeping resumable state", async () => {
  const { inbox, client } = await fixture({ run: (args, { signal }) => args.includes("GET") ? http(rows) :
    new Promise((resolve, reject) => signal.addEventListener("abort",
      () => reject(new InboxError("closed", "Synthetic cancellation", 410)), { once: true })) });
  inbox.batch.start(selection(inbox));
  await settle();
  inbox.close();
  await inbox.batch.done;
  assert.equal(inbox.batch.snapshot(), null);
  assert.equal(client.threadReservations.size, 0);
  assert.equal(client.pendingThreads.size, 0);
});

test("the protected shown-batch HTTP path requires a selection and does not persist notification history", async t => {
  const directory = await mkdtemp(join(tmpdir(), "notification-shown-"));
  const preferences = new Preferences({ directory });
  await preferences.update({ groupBy: "none" });
  const files = await readdir(directory);
  const settings = await readFile(join(directory, "settings.json"), "utf8");
  const { inbox, writes } = await fixture();
  const server = await startServer(inbox, { preferences });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const post = (input, overrides = {}) => fetch(`${url.origin}/api/batch/start`, {
    method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(input),
  });
  const input = selection(inbox);
  assert.equal((await post(input, { Origin: "https://example.invalid" })).status, 403);
  assert.equal((await post({ scope: "shown" })).status, 400);
  assert.deepEqual(writes, []);
  const response = await post(input);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).batch.scope, "shown");
  await inbox.batch.done;
  assert.deepEqual(writes, ["1", "2", "3"].map(id => ({ method: "DELETE", id })));
  assert.deepEqual(await readdir(directory), files);
  assert.equal(await readFile(join(directory, "settings.json"), "utf8"), settings);
});
