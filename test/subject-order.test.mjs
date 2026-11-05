import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { normalizeThreads } from "../src/model.mjs";
import { startServer } from "../src/server.mjs";
import { http, thread } from "./fixtures.mjs";

function rows() {
  return [
    ["1", "example/zulu", "2026-01-01T22:30:00Z", "Other"],
    ["2", "example/alpha", "2026-01-02T01:30:00Z", "Keep"],
    ["3", "example/zulu", "2026-01-02T07:30:00Z", "Keep"],
    ["4", "example/alpha", "2026-01-03T08:30:00Z", "Keep"],
    ["5", "example/beta", "2026-01-01T12:00:00Z", "Other"],
  ].map(([id, repository, updated_at, title]) => thread(id, {
    repository: { full_name: repository }, updated_at,
    subject: { type: "Issue", title: `${title} synthetic issue ${id}`, url: `https://api.github.com/repos/${repository}/issues/${id}` },
  }));
}

async function setup(t, count, { holdFirst = false, preferences } = {}) {
  const calls = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const client = new GitHubClient({ run: async args => {
    const endpoint = args.at(-1);
    if (endpoint.startsWith("/notifications")) return http(rows());
    const id = endpoint.match(/\/issues\/(\d+)$/)?.[1];
    assert.ok(id);
    calls.push(id);
    if (holdFirst && calls.length === 1) await held;
    if (calls.length === count) finish();
    return http({ state: "closed", state_reason: "completed" });
  } });
  const inbox = new Inbox(client);
  const server = await startServer(inbox, { development: null, preferences });
  t.after(async () => { release(); await server.close(); });
  const url = new URL(server.url);
  const call = async (path, body, view = {}) => {
    const response = await fetch(`${url.origin}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json", ...view },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  return { client, inbox, call, calls, release, finished };
}

test("status lookups follow repository, flat, and browser-local date order", { timeout: 5000 }, async t => {
  for (const [groupBy, timeZone, expected] of [
    ["repo", "UTC", ["1", "3", "2", "4", "5"]],
    ["none", "UTC", ["1", "2", "3", "4", "5"]],
    ["date", "UTC", ["4", "2", "3", "1", "5"]],
    ["date", "America/Los_Angeles", ["4", "1", "2", "3", "5"]],
  ]) {
    await t.test(`${groupBy} ${timeZone}`, async subtest => {
      const fixture = await setup(subtest, 5);
      const result = await fixture.call("refresh", {}, {
        "X-Notification-Group-By": groupBy, "X-Notification-Time-Zone": timeZone,
      });
      assert.equal(result.status, 200);
      await fixture.finished;
      assert.deepEqual(fixture.calls, expected);
      assert.doesNotMatch(JSON.stringify(fixture.inbox.summary()), /subjectLoading|subjectView|timeZone|example\/|Keep synthetic/);
    });
  }
});

test("a new grouping and filter reprioritize remaining lookups after the current row", { timeout: 5000 }, async t => {
  const fixture = await setup(t, 4, { holdFirst: true });
  const initial = await fixture.call("refresh", {}, { "X-Notification-Group-By": "repo" });
  assert.equal(initial.data.groups[0].items[0].subjectLoading, true);
  assert.deepEqual(fixture.calls, ["1"]);
  const filtered = await fixture.call("filters", { query: "Keep" }, { "X-Notification-Group-By": "none" });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.matching, 3);
  fixture.release();
  await fixture.finished;
  assert.deepEqual(fixture.calls, ["1", "2", "3", "4"]);
  await fixture.client.queue;
  const loaded = await fixture.call("state");
  assert.equal(loaded.data.subjectsLoading, false);
  assert.ok(loaded.data.groups.every(group => group.items.every(item => !item.subjectLoading)));
});

test("saved date grouping does not block the inbox before the renderer supplies its time zone", { timeout: 5000 }, async t => {
  const fixture = await setup(t, 5, { preferences: { read: async () => ({ matchGitHubInbox: true, groupBy: "date" }) } });
  const initial = await fixture.call("refresh", {});
  assert.equal(initial.status, 200);
  assert.equal(initial.data.loaded, 5);
  assert.equal(initial.data.subjectsLoading, false);
  assert.deepEqual(fixture.calls, []);
  await fixture.call("state", undefined, { "X-Notification-Time-Zone": "America/Los_Angeles" });
  await fixture.finished;
  assert.deepEqual(fixture.calls, ["4", "1", "2", "3", "5"]);
});

test("unsupported presentation headers fail before fetching notification or subject data", async t => {
  let calls = 0;
  const client = new GitHubClient({ run: async () => { calls++; return http([]); } });
  const inbox = new Inbox(client);
  const server = await startServer(inbox, { development: null });
  t.after(() => server.close());
  const url = new URL(server.url);
  for (const view of [
    { "X-Notification-Group-By": "invalid" },
    { "X-Notification-Group-By": "date" },
    { "X-Notification-Time-Zone": "Invalid/Zone" },
    { "X-Notification-Time-Zone": "x".repeat(129) },
  ]) {
    const result = await fetch(`${url.origin}/api/refresh`, {
      method: "POST", headers: {
        Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json", ...view,
      }, body: "{}",
    });
    assert.equal(result.status, 400);
  }
  assert.equal(calls, 0);
});

test("dynamic subject lists retain deduplication and can drop all pending rows", async () => {
  const all = normalizeThreads(rows());
  for (const remaining of [[], [all[3], all[2], all[3]]]) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const calls = [];
    let items = all;
    const client = new GitHubClient({ run: async args => {
      calls.push(args.at(-1));
      if (calls.length === 1) { entered(); await held; }
      return http({ state: "closed" });
    } });
    const loading = client.refreshSubjects(() => items);
    await started;
    items = remaining;
    release();
    await loading;
    assert.deepEqual(calls.map(path => path.split("/").at(-1)), remaining.length ? ["1", "4", "3"] : ["1"]);
  }
});

test("a PR filtered out during its REST lookup does not start a new merge queue lookup", async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let items = normalizeThreads([thread()]);
  let calls = 0;
  const client = new GitHubClient({ run: async args => {
    calls++;
    assert.notEqual(args.at(-1), "graphql");
    entered();
    await held;
    return http({ state: "open", merged: false, draft: false });
  } });
  const loading = client.refreshSubjects(() => items);
  await started;
  items = [];
  release();
  await loading;
  assert.equal(calls, 1);
});

test("viewport reports defer all lookups until rows enter view and ignore unknown IDs", { timeout: 5000 }, async t => {
  const fixture = await setup(t, 2);
  const initial = await fixture.call("refresh", {}, { "X-Notification-Visible-Ids": "" });
  assert.equal(initial.status, 200);
  assert.equal(initial.data.loaded, 5);
  assert.equal(initial.data.subjectsLoading, false);
  assert.deepEqual(fixture.calls, []);
  await fixture.call("state", undefined, { "X-Notification-Visible-Ids": "3,1,999999" });
  await fixture.finished;
  assert.deepEqual(fixture.calls, ["3", "1"]);
  const snapshot = await fixture.call("state", undefined, { "X-Notification-Visible-Ids": "" });
  assert.equal(snapshot.data.loaded, 5);
  assert.ok(snapshot.data.groups.every(group => group.items.every(item => !item.subjectLoading)));
  assert.doesNotMatch(JSON.stringify(fixture.inbox.summary()), /subjectCheckedAt|subjectStateStale|subjectViewport/);
});

test("collapsing a viewport while a lookup is running drops pending off-screen work", async t => {
  const fixture = await setup(t, 1, { holdFirst: true });
  await fixture.call("refresh", {}, { "X-Notification-Visible-Ids": "1,3,2,4,5" });
  assert.deepEqual(fixture.calls, ["1"]);
  await fixture.call("state", undefined, { "X-Notification-Visible-Ids": "" });
  fixture.release();
  await fixture.finished;
  await fixture.client.queue;
  const snapshot = await fixture.call("state");
  assert.equal(snapshot.data.subjectsLoading, false);
  assert.deepEqual(fixture.calls, ["1"]);
});

test("malformed viewport metadata is rejected before fetching or writing", async t => {
  const fixture = await setup(t, 0);
  for (const viewport of ["1,1", "1,,2", "1, 2", "-1", "1x", "1/2", "9".repeat(8193)]) {
    const result = await fixture.call("refresh", {}, { "X-Notification-Visible-Ids": viewport });
    assert.equal(result.status, 400);
    assert.equal(result.data.error.code, "invalid_viewport");
  }
  assert.equal(fixture.inbox.pages.length, 0);
  assert.deepEqual(fixture.calls, []);
});
