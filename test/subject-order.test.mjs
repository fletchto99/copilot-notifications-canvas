import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, firstPage } from "../src/github.mjs";
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

function extraRows(count = 20) {
  return Array.from({ length: count }, (_, index) => thread(String(index + 101), {
    repository: { full_name: "example/first" },
    subject: { type: "Issue", title: "Other synthetic issue",
      url: `https://api.github.com/repos/example/first/issues/${index + 101}` },
  }));
}

async function setup(t, count, { holdFirst = false, preferences, initialRows = rows() } = {}) {
  initialRows = initialRows.map(row => ({ ...row, subject: { ...row.subject,
    type: "CheckSuite", url: row.subject.url.replace("/issues/", "/actions/runs/"),
  } }));
  const calls = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const client = new GitHubClient({ run: async args => {
    const endpoint = args.at(-1);
    if (endpoint.startsWith("/notifications")) return http(initialRows);
    const id = endpoint.match(/\/actions\/runs\/(\d+)$/)?.[1];
    assert.ok(id);
    calls.push(id);
    if (holdFirst && calls.length <= 20) await held;
    if (calls.length === count) finish();
    return http({ status: "completed", conclusion: "success" });
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

test("a new grouping and filter reprioritize rows after the in-flight lookups", { timeout: 5000 }, async t => {
  const first = extraRows();
  const fixture = await setup(t, 23, { holdFirst: true, initialRows: [...first, ...rows()] });
  const initial = await fixture.call("refresh", {}, { "X-Notification-Group-By": "repo" });
  assert.equal(initial.data.groups[0].items[0].subjectLoading, true);
  assert.deepEqual(fixture.calls, first.map(row => row.id));
  const filtered = await fixture.call("filters", { query: "Keep" }, { "X-Notification-Group-By": "none" });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.matching, 3);
  fixture.release();
  await fixture.finished;
  assert.deepEqual(fixture.calls, [...first.map(row => row.id), "2", "3", "4"]);
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
  const all = normalizeThreads(extraRows(25));
  for (const remaining of [[], [all[23], all[22], all[23]]]) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const calls = [];
    let items = all;
    const client = new GitHubClient({ run: async args => {
      calls.push(args.at(-1));
      if (calls.length === 20) entered();
      if (calls.length <= 20) await held;
      return http({ state: "closed" });
    } });
    const loading = client.refreshSubjects(() => items);
    await started;
    items = remaining;
    release();
    await loading;
    assert.deepEqual(calls.map(path => path.split("/").at(-1)), [
      ...all.slice(0, 20).map(item => item.number), ...(remaining.length ? ["124", "123"] : []),
    ]);
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

test("re-expanding a PR resumes skipped phases while another subject remains in flight", async t => {
  for (const phase of ["state", "queued phase"]) {
    await t.test(phase, async subtest => {
      let releasePR;
      const heldPR = new Promise(resolve => { releasePR = resolve; });
      let releaseSlow;
      const heldSlow = new Promise(resolve => { releaseSlow = resolve; });
      let releasePage;
      const heldPage = new Promise(resolve => { releasePage = resolve; });
      const all = normalizeThreads([thread(), thread("2", {
        subject: { type: "Issue", title: "Synthetic slow issue", url: "https://api.github.com/repos/example/widgets/issues/2" },
      })]);
      let items = all;
      const calls = [];
      const client = new GitHubClient({ run: async args => {
        const path = args.at(-1);
        calls.push(path);
        if (path === "graphql") return http({ data: { repository: { pullRequest: { isInMergeQueue: true } } } });
        if (path.startsWith("/notifications?")) { await heldPage; return http([]); }
        await (path.endsWith("/pulls/42") ? heldPR : heldSlow);
        return http({ state: "open", merged: false, draft: false });
      } });
      const loading = client.refreshSubjects(() => items);
      let foreground;
      subtest.after(async () => { releasePR(); releaseSlow(); releasePage(); await Promise.all([loading, foreground]); });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls, ["/repos/example/widgets/pulls/42", "/repos/example/widgets/issues/2"]);
      items = [all[1]];
      client.wakeSubjects();
      items = all;
      client.wakeSubjects();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.filter(path => path.endsWith("/pulls/42")).length, 1,
        "Re-expansion must not duplicate a REST lookup still in flight");
      if (phase === "queued phase") {
        foreground = client.page(firstPage());
        releasePR();
        await new Promise(resolve => setImmediate(resolve));
      }
      items = [all[1]];
      client.wakeSubjects();
      releasePR();
      releasePage();
      await foreground;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.includes("graphql"), false);
      assert.equal(client.subjectSnapshot(all[0]).subjectState, "open");
      assert.equal(client.subjectWorkers.size, 1, "The unrelated request keeps this refresh pass alive");
      items = [all[0], all[0], all[1]];
      client.wakeSubjects();
      client.wakeSubjects();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.filter(path => path === "graphql").length, 1,
        "The skipped phase resumes before the unrelated request finishes");
      assert.equal(calls.filter(path => path.endsWith("/pulls/42")).length, 1, "The cached REST result is reused");
      assert.equal(client.subjectSnapshot(all[0]).subjectState, "merge_queued");
      releaseSlow();
      await loading;
      assert.equal(client.subjectRefreshes.size, 0);
    });
  }
});

test("rows dropped while their first lookup waits in the shared queue are not fetched", async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const client = new GitHubClient({ run: async args => {
    const path = args.at(-1);
    calls.push(path);
    if (path.startsWith("/notifications")) {
      entered();
      await held;
      return http(rows());
    }
    return http({ state: "closed" });
  } });
  const foreground = client.page(firstPage());
  await started;
  const all = normalizeThreads(rows());
  let items = all.slice(0, 2);
  const loading = client.refreshSubjects(() => items);
  items = [all[3], all[2]];
  release();
  await Promise.all([foreground, loading]);
  assert.deepEqual(calls.slice(1), ["/repos/example/alpha/issues/4", "/repos/example/zulu/issues/3"]);
});

test("related phases recheck selection after waiting behind a foreground request", async () => {
  let releaseState;
  const heldState = new Promise(resolve => { releaseState = resolve; });
  let stateEntered;
  const stateStarted = new Promise(resolve => { stateEntered = resolve; });
  let releasePage;
  const heldPage = new Promise(resolve => { releasePage = resolve; });
  let pageEntered;
  const pageStarted = new Promise(resolve => { pageEntered = resolve; });
  const calls = [];
  const client = new GitHubClient({ run: async args => {
    const path = args.at(-1);
    calls.push(path);
    if (path.startsWith("/notifications")) {
      pageEntered();
      await heldPage;
      return http([thread()]);
    }
    assert.notEqual(path, "graphql", "An obsolete queued phase must not make a request");
    stateEntered();
    await heldState;
    return http({ state: "open", merged: false, draft: false });
  } });
  let items = normalizeThreads([thread()]);
  const loading = client.refreshSubjects(() => items);
  await stateStarted;
  const foreground = client.page(firstPage());
  releaseState();
  await pageStarted;
  items = [];
  releasePage();
  await Promise.all([foreground, loading]);
  assert.equal(calls.length, 2);
});

test("expanded-row selections defer lookups until committed and preserve display order", { timeout: 5000 }, async t => {
  const fixture = await setup(t, 2);
  const initial = await fixture.call("refresh", {}, { "X-Notification-Subjects": "manual" });
  assert.equal(initial.status, 200);
  assert.equal(initial.data.loaded, 5);
  assert.equal(initial.data.subjectsLoading, false);
  assert.deepEqual(fixture.calls, []);
  const selectionKey = initial.data.selectionKey;
  await fixture.call("subjects", { version: 1, selectionKey, offset: 0, positions: [2, 0], complete: true });
  await fixture.call("state");
  await fixture.finished;
  assert.deepEqual(fixture.calls, ["3", "1"]);
  await fixture.call("subjects", { version: 2, selectionKey, offset: 0, positions: [], complete: true });
  const snapshot = await fixture.call("state");
  assert.equal(snapshot.data.loaded, 5);
  assert.ok(snapshot.data.groups.every(group => group.items.every(item => !item.subjectLoading)));
  assert.doesNotMatch(JSON.stringify(fixture.inbox.summary()), /subjectCheckedAt|subjectStateStale|subjectSelection/);
});

test("collapsing all groups while lookups are running drops pending status work", async t => {
  const first = extraRows();
  const fixture = await setup(t, 20, { holdFirst: true, initialRows: [...first, ...rows()] });
  const initial = await fixture.call("refresh", {}, { "X-Notification-Subjects": "manual" });
  const selectionKey = initial.data.selectionKey;
  await fixture.call("subjects", { version: 1, selectionKey, offset: 0,
    positions: [...first.map((_, index) => index), 20, 22, 21, 23, 24], complete: true });
  await fixture.call("state");
  assert.deepEqual(fixture.calls, first.map(row => row.id));
  await fixture.call("subjects", { version: 2, selectionKey, offset: 0, positions: [], complete: true });
  fixture.release();
  await fixture.finished;
  await fixture.client.queue;
  const snapshot = await fixture.call("state");
  assert.equal(snapshot.data.subjectsLoading, false);
  assert.deepEqual(fixture.calls, first.map(row => row.id));
});

test("malformed status selections are rejected before fetching or writing", async t => {
  const fixture = await setup(t, 0);
  const valid = { version: 1, selectionKey: fixture.inbox.shownSelection().selectionKey, offset: 0, positions: [], complete: true };
  for (const change of [
    { version: 0 }, { version: "1" }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { selectionKey: "bad" }, { offset: -1 }, { complete: "true" }, { complete: false },
    { positions: [1, 1] }, { positions: "1" }, { positions: [-1] }, { positions: [0.5] }, { positions: [null] },
    { positions: Array.from({ length: 101 }, (_, index) => index) }, { unexpected: true },
  ]) {
    const result = await fixture.call("subjects", { ...valid, ...change });
    assert.equal(result.status, 400);
    assert.equal(result.data.error.code, "invalid_subject_selection");
  }
  assert.equal(fixture.inbox.pages.length, 0);
  assert.deepEqual(fixture.calls, []);
});

test("expanding a selection replenishes idle workers without waiting for a slow existing lookup", async t => {
  const fixture = await setup(t, 25, { holdFirst: true, initialRows: extraRows(25) });
  const initial = await fixture.call("refresh", {}, { "X-Notification-Subjects": "manual" });
  const selectionKey = initial.data.selectionKey;
  await fixture.call("subjects", { version: 1, selectionKey, offset: 0, positions: [0], complete: true });
  await fixture.call("state");
  assert.equal(fixture.calls.length, 1);
  await fixture.call("subjects", {
    version: 2, selectionKey, offset: 0, positions: Array.from({ length: 25 }, (_, index) => index), complete: true,
  });
  await fixture.call("state");
  assert.equal(fixture.calls.length, 20, "The expanded selection must fill free slots before the first lookup finishes");
  fixture.release();
  await fixture.finished;
  assert.equal(new Set(fixture.calls).size, 25);
});
