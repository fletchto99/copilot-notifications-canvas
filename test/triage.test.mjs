import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { InboxError } from "../src/model.mjs";
import { NotificationTriage } from "../src/triage.mjs";
import { syntheticTriage } from "./triage-fixtures.mjs";
import { http, thread } from "./fixtures.mjs";

async function setup(t, { run = syntheticTriage, rows = [thread("1")], timeout, github } = {}) {
  const requests = [];
  const logs = [];
  const client = new GitHubClient({ run: async args => {
    requests.push(args);
    assert.ok(args.includes("GET"), "Triage must not write to GitHub");
    return args.at(-1).startsWith("/notifications?") ? http(rows) : github(args);
  } });
  const inbox = new Inbox(client);
  await inbox.refresh();
  const triage = new NotificationTriage(inbox, { run, timeout, log: message => logs.push(message) });
  t.after(async () => { inbox.close(); await triage.close(); });
  const start = () => triage.start({ selectionKey: inbox.shownSelection().selectionKey, consent: true });
  return { inbox, triage, start, requests, logs };
}

test("triage requires explicit consent for the current nonempty shown selection", async t => {
  let runs = 0;
  const f = await setup(t, { run: async options => { runs++; return syntheticTriage(options); } });
  assert.deepEqual(f.triage.snapshot(), { status: "idle" });
  for (const input of [null, {}, { consent: false }, { consent: true, selectionKey: "bad" },
    { consent: true, selectionKey: f.inbox.shownSelection().selectionKey, extra: true }]) {
    assert.throws(() => f.triage.start(input), { code: "triage_consent" });
  }
  assert.throws(() => f.triage.start({ consent: true, selectionKey: "f".repeat(64) }), { code: "selection_changed" });
  await f.inbox.setFilters({ query: "absent" });
  assert.throws(f.start, { code: "invalid_selection" });
  assert.equal(runs, 0);
});

test("agent tools expose only shown snapshots in bounded pages; results never enter summaries", async t => {
  const rows = Array.from({ length: 43 }, (_, index) => thread(String(index + 1),
    { repository: { full_name: index === 42 ? "hidden/repo" : "selected/repo" } }));
  const f = await setup(t, { rows });
  await f.inbox.setFilters({ query: "selected/repo" });
  f.start();
  await f.triage.done;
  const state = f.triage.snapshot();
  assert.equal(state.status, "complete");
  assert.equal(state.total, 42);
  assert.equal(state.results.length, 42);
  assert.ok(state.results.every(result => result.context === "notification" && result.id !== "43"));
  assert.equal(f.requests.length, 1, "Listing reuses the scoped GitHub snapshot");
  assert.equal("triage" in f.inbox.summary(), false);
  assert.equal(JSON.stringify(f.inbox.summary()).includes("Synthetic"), false);
  assert.ok(f.triage.operation.items.every(item => Object.keys(item).join() === "id"));
  assert.equal(f.triage.operation.context.size, 0);
  assert.throws(() => f.triage.dismiss({ token: "old" }), { code: "unknown_triage" });
  f.triage.dismiss({ token: state.token });
  assert.deepEqual(f.triage.snapshot(), { status: "idle" });
});

test("Copilot chooses bounded context reads and repeated reads share an in-memory result", async t => {
  const f = await setup(t, { rows: [thread("1", {
    subject: { type: "PullRequest", title: "Review me", url: "https://api.github.com/repos/example/widgets/pulls/42" },
  })], github: async args => args.at(-1).includes("/comments?")
    ? http([{ body: "x".repeat(2000), updated_at: "2026-01-01T00:00:00Z" }])
    : http({ title: "Review me", body: "x".repeat(7000), state: "open", comments: 25, draft: false, merged: false }),
  run: async options => {
    const output = await syntheticTriage(options);
    for (let i = 0; i < 2; i++) {
      const response = await options.tools[1].handler({ ref: "n1" });
      assert.equal(response.resultType, "success");
      const context = JSON.parse(response.textResultForLlm);
      assert.equal(context.body.length, 6000);
      assert.equal(context.comments[0].body.length, 1500);
      assert.equal(context.merged, false);
    }
    return output;
  } });
  f.start();
  await f.triage.done;
  assert.equal(f.triage.snapshot().status, "complete");
  assert.equal(f.triage.snapshot().inspected, 1);
  assert.equal(f.triage.snapshot().results[0].context, "thread");
  assert.deepEqual(f.requests.slice(1).map(args => args.at(-1)), [
    "/repos/example/widgets/pulls/42", "/repos/example/widgets/issues/42/comments?per_page=10&page=3",
  ]);
  assert.equal(f.inbox.client.cache.size, 1, "Thread bodies never enter the notification page cache");
});

test("unsupported notification types explicitly report unavailable context without fetching", async t => {
  const f = await setup(t, { rows: [thread("1", { subject: { type: "Discussion", title: "Discuss", url: null } })],
    run: async options => {
      const output = await syntheticTriage(options);
      const response = await options.tools[1].handler({ ref: "n1" });
      assert.equal(JSON.parse(response.textResultForLlm).available, false);
      return output;
    },
  });
  f.start();
  await f.triage.done;
  assert.equal(f.triage.snapshot().status, "complete");
  assert.equal(f.requests.length, 1);
});

test("invalid tool arguments fail closed before any additional GitHub request", async t => {
  for (const [index, input] of [[0, {}], [0, { offset: -1 }], [0, { offset: 1 }], [0, { offset: 0.5 }],
    [1, { ref: "n99" }], [1, { ref: "n1", url: "https://evil.test" }]]) {
    const f = await setup(t, { run: async options => {
      const result = await options.tools[index].handler(input);
      assert.equal(result.resultType, "failure");
      return {};
    } });
    f.start();
    await f.triage.done;
    assert.equal(f.triage.snapshot().status, "error");
    assert.equal(f.requests.length, 1);
  }
});

test("untrusted incomplete, duplicate and invalid model results are rejected", async t => {
  for (const mutate of [
    () => null, () => ({}), () => ({ recommendations: [] }),
    output => ({ ...output, extra: true }),
    output => ({ recommendations: [...output.recommendations, ...output.recommendations] }),
    output => { output.recommendations[0].ref = "n99"; return output; },
    output => { output.recommendations[0].category = "execute"; return output; },
    output => { output.recommendations[0].reason = "x".repeat(501); return output; },
    output => { output.recommendations[0].reason = " "; return output; },
    output => { output.recommendations[0].extra = true; return output; },
  ]) {
    const f = await setup(t, { run: async options => mutate(await syntheticTriage(options)) });
    f.start();
    await f.triage.done;
    assert.equal(f.triage.snapshot().status, "error");
    assert.equal(f.triage.snapshot().error.code, "triage_result");
    assert.deepEqual(f.triage.snapshot().results, []);
  }
  const f = await setup(t, { rows: [thread("1"), thread("2")], run: async options => {
    const output = await syntheticTriage(options);
    output.recommendations[1] = output.recommendations[0];
    return output;
  } });
  f.start();
  await f.triage.done;
  assert.equal(f.triage.snapshot().error.code, "triage_result");
});

test("changed filters, read actions and notification content invalidate recommendations", async t => {
  for (const change of [
    inbox => inbox.setFilters({ attention: "mentioned" }),
    inbox => { inbox.pages[0].items = []; },
    inbox => { inbox.pages[0].items[0].title = "Changed with the same timestamp"; },
  ]) {
    const f = await setup(t);
    f.start();
    await f.triage.done;
    await change(f.inbox);
    assert.equal(f.triage.snapshot().status, "stale");
    assert.deepEqual(f.triage.snapshot().results, []);
  }
});

test("cancellation blocks overlapping runs and dismissal until cleanup finishes", async t => {
  let finish;
  const f = await setup(t, { run: options => new Promise(resolve => {
    finish = () => resolve({ recommendations: [] });
    options.signal.addEventListener("abort", () => {}, { once: true });
  }) });
  f.start();
  assert.throws(f.start, { code: "busy" });
  const { token } = f.triage.snapshot();
  assert.throws(() => f.triage.cancel({ token: "wrong" }), { code: "unknown_triage" });
  f.triage.cancel({ token });
  f.triage.cancel({ token });
  assert.equal(f.triage.snapshot().status, "cancelled");
  assert.throws(f.start, { code: "busy" });
  assert.throws(() => f.triage.dismiss({ token }), { code: "busy" });
  finish();
  await f.triage.done;
  f.triage.dismiss({ token });
  await f.triage.close();
  assert.throws(f.start, { code: "closed" });
});

test("timeouts and panel closure abort only the owned work and report failures", async t => {
  for (const close of [false, true]) {
    const f = await setup(t, { timeout: 5, run: ({ signal }) => new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
    f.start();
    if (close) f.inbox.close();
    await f.triage.done;
    assert.equal(f.triage.snapshot().status, "error");
    assert.equal(f.triage.snapshot().error.code, close ? "closed" : "triage_timeout");
  }
});

test("stale in-flight tools stop without new data; cleanup failures remain visible after cancellation", async t => {
  let continueRun;
  const f = await setup(t, { run: async options => {
    await new Promise(resolve => { continueRun = resolve; });
    const result = await options.tools[0].handler({ offset: 0 });
    assert.equal(result.resultType, "failure");
    return {};
  } });
  f.start();
  await f.inbox.setFilters({ query: "absent" });
  assert.equal(f.triage.snapshot().status, "stale");
  continueRun();
  await f.triage.done;
  assert.equal(f.triage.snapshot().status, "stale");

  const cleanup = await setup(t, { run: ({ signal }) => new Promise((resolve, reject) =>
    signal.addEventListener("abort", () => reject(new InboxError("triage_cleanup", "Cleanup failed.", 500)), { once: true })) });
  cleanup.start();
  cleanup.triage.cancel({ token: cleanup.triage.snapshot().token });
  await cleanup.triage.done;
  assert.equal(cleanup.triage.snapshot().error.code, "triage_cleanup");
});

test("tool budgets and unexpected errors never expose raw failures or notification content", async t => {
  for (const run of [
    async () => { throw new Error("PRIVATE DATA"); },
    async options => {
      for (let i = 0; i < 24; i++) await options.tools[0].handler({ offset: 0 });
      return {};
    },
  ]) {
    const f = await setup(t, { run });
    f.start();
    await f.triage.done;
    assert.equal(f.triage.snapshot().status, "error");
    assert.doesNotMatch(JSON.stringify([f.triage.snapshot(), f.logs]), /PRIVATE DATA|Synthetic notification/);
  }
});
