import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { startServer } from "../src/server.mjs";
import { http, thread } from "./fixtures.mjs";

async function setup(t, count = 250) {
  const rows = Array.from({ length: count }, (_, index) => thread(String(1000000000000 + index), {
    subject: { type: "Issue", title: `Synthetic issue ${index + 1}`,
      url: `https://api.github.com/repos/example/widgets/issues/${index + 1}` },
  }));
  const requests = [];
  const client = new GitHubClient({ run: async args => {
    const path = args.at(-1);
    requests.push({ path, method: args[4] });
    if (args.includes("PATCH") || args.includes("DELETE")) return http(null, {}, args.includes("PATCH") ? 205 : 204);
    return path.startsWith("/notifications?") ? http(rows) : http({ state: "closed" });
  } });
  const inbox = new Inbox(client);
  const server = await startServer(inbox, { development: null });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin,
    "Content-Type": "application/json", "X-Notification-Subjects": "manual" };
  const call = async (path, body, overrides = {}) => {
    const result = await fetch(new URL(`/api/${path}`, url), {
      method: body === undefined ? "GET" : "POST", headers: { ...headers, ...overrides },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.status, data: await result.json() };
  };
  const initial = await call("refresh", {});
  assert.equal(initial.status, 200);
  const selectionKey = initial.data.selectionKey;
  const select = (changes = {}) => call("subjects", {
    selectionKey, version: 1, offset: 0, positions: [], complete: true, ...changes,
  });
  const statuses = () => requests.filter(({ path }) => path.startsWith("/repos/"));
  const finish = async () => {
    while (client.subjectWorkers.size) await Promise.all(client.subjectWorkers);
  };
  return { rows, call, select, requests, statuses, client, inbox, finish, selectionKey };
}

test("large selections use bounded chunks, publish atomically and leave ordinary actions independent", async t => {
  const f = await setup(t, 650);
  assert.ok(f.rows.map(row => row.id).join(",").length > 8192);
  const positions = f.rows.map((_, index) => index).reverse();
  for (let offset = 0; offset < positions.length; offset += 100) {
    const input = {
      version: 1, selectionKey: f.selectionKey, offset,
      positions: positions.slice(offset, offset + 100), complete: offset + 100 >= positions.length,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 4096);
    const selected = await f.call("subjects", input);
    assert.equal(selected.status, 200);
    assert.deepEqual(selected.data, { status: input.complete ? "complete" : "pending", version: 1 },
      "Chunks do not return entire inbox snapshots");
    if (!input.complete) {
      assert.equal((await f.call("state")).data.subjectsLoading, false);
      assert.equal(f.statuses().length, 0, "An incomplete upload must not dispatch lookups");
      assert.equal((await f.call("refresh", {})).status, 200);
    }
  }
  await f.call("state");
  await f.finish();
  assert.deepEqual(f.statuses().map(({ path }) => path), positions.map(index => `/repos/example/widgets/issues/${index + 1}`));
  assert.equal((await f.call("read", { id: f.rows[0].id })).status, 200);
  assert.equal((await f.call("done", { id: f.rows[1].id })).status, 200);
  assert.equal((await f.call("state")).data.loaded, 649);
  assert.doesNotMatch(JSON.stringify(f.inbox.summary()), /subjectSelection|positions|Synthetic|example\//);
});

test("stale, duplicate and out-of-order chunks cannot replace a newer selection", async t => {
  const f = await setup(t);
  assert.equal((await f.select({ positions: [0, 1], complete: false })).status, 200);
  for (const change of [
    { version: 1 }, { version: 0, offset: 2 }, { version: 2, offset: 2 },
    { offset: 1, positions: [2] }, { offset: 3, positions: [2] },
    { offset: 2, positions: [2], selectionKey: "a".repeat(64) },
  ]) {
    const result = await f.select(change);
    assert.equal(result.status, change.version === 0 ? 400 : 409);
  }
  for (const change of [
    { offset: 2, positions: [1] }, { offset: 2, positions: [2, 2] },
    { offset: 2, positions: [250] },
  ]) {
    assert.equal((await f.select(change)).status, 400);
  }
  assert.equal((await f.select({ version: 2, positions: [4, 3], complete: true })).status, 200);
  assert.equal((await f.select({ offset: 2, positions: [2] })).status, 409);
  assert.equal((await f.select({ version: 2, offset: 2, positions: [2] })).status, 409);
  await f.call("state");
  await f.finish();
  assert.deepEqual(f.statuses().map(({ path }) => path), ["/repos/example/widgets/issues/5", "/repos/example/widgets/issues/4"]);
  const snapshot = (await f.call("state")).data;
  assert.equal(snapshot.subjectSelectionVersion, 2);
  assert.equal((await f.select({ version: snapshot.subjectSelectionVersion + 1, positions: [] })).status, 200,
    "A reloaded renderer can start a fresh upload using the snapshot version");
});

test("refresh, filters and triage invalidate position mappings instead of selecting different rows", async t => {
  for (const action of ["refresh", "filters", "read", "done"]) {
    await t.test(action, async subtest => {
      const f = await setup(subtest, 3);
      await f.select({ positions: [0], complete: false });
      if (action === "refresh") f.rows.reverse();
      const result = await f.call(action, action === "refresh" ? { force: true } :
        action === "filters" ? { query: "issue 2" } : { id: f.rows[0].id });
      assert.equal(result.status, 200, "Ordinary actions remain available during an upload");
      const stale = await f.select({ offset: 1, positions: [1], complete: true });
      assert.equal(stale.status, 200);
      assert.deepEqual(stale.data, { status: "stale", version: 1 });
      assert.equal((await f.select({ offset: 1, positions: [1], complete: true })).status, 409,
        "A stale snapshot discards its pending upload; chunks cannot continue it");
      await f.call("state");
      assert.equal(f.statuses().length, 0);
      const current = (await f.call("state")).data;
      assert.equal((await f.select({ version: 2, selectionKey: current.selectionKey, positions: [0] })).status, 200);
      await f.call("state");
      await f.finish();
      const expected = action === "refresh" ? 3 : action === "filters" || action === "done" ? 2 : 1;
      assert.deepEqual(f.statuses().map(({ path }) => path), [`/repos/example/widgets/issues/${expected}`]);
    });

  }
});

test("a stale first chunk requests a fresh snapshot without clearing an existing selection", async t => {
  const f = await setup(t, 3);
  assert.equal((await f.select({ positions: [0] })).status, 200);
  const stale = await f.select({ version: 2, selectionKey: "a".repeat(64), positions: [999], complete: false });
  assert.equal(stale.status, 200);
  assert.deepEqual(stale.data, { status: "stale", version: 1 });
  await f.call("state");
  await f.finish();
  assert.deepEqual(f.statuses().map(({ path }) => path), ["/repos/example/widgets/issues/1"]);
  assert.equal((await f.select({ version: 2, positions: [999] })).status, 400,
    "Positions outside the current snapshot remain invalid");
});

test("status selection retains authentication, same-origin POST and request-size limits", async t => {
  const f = await setup(t, 2);
  assert.equal((await f.call("subjects")).status, 405);
  for (const headers of [
    { Authorization: "" }, { Origin: "https://evil.test" }, { Origin: "" },
    { "Sec-Fetch-Site": "cross-site" },
  ]) {
    assert.equal((await f.call("subjects", {}, headers)).status, 403);
  }
  assert.equal((await f.call("subjects", {}, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await f.call("subjects", { text: "x".repeat(4096) })).status, 413);
  assert.equal((await f.call("refresh", {}, { "X-Notification-Subjects": "invalid" })).status, 400);
  assert.equal(f.statuses().length, 0);
  assert.equal((await f.call("read", { id: f.rows[0].id })).status, 200);
});
