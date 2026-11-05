import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, RETRY_MS } from "../src/github.mjs";
import { normalizeThreads } from "../src/model.mjs";
import { http, thread, workflowRun } from "./fixtures.mjs";

const cases = [
  ["issue", { type: "Issue", url: "https://api.github.com/repos/example/widgets/issues/1" },
    path => path.endsWith("/issues/1"), "subjectCache", "/repos/example/widgets/issues/1"],
  ["discussion", { type: "Discussion", url: "https://api.github.com/repos/example/widgets/discussions/1" },
    path => path === "graphql", "subjectCache", "/repos/example/widgets/discussions/1"],
  ["merge queue", { type: "PullRequest", url: "https://api.github.com/repos/example/widgets/pulls/42" },
    path => path === "graphql", "mergeQueueCache", "/repos/example/widgets/pulls/42"],
  ["suite run", { type: "CheckSuite", url: "https://api.github.com/repos/example/widgets/check-suites/7" },
    path => path.includes("check_suite_id="), "checkRunCache", "/repos/example/widgets/check-suites/7"],
  ["inferred run", { type: "CheckSuite", url: null },
    path => path.includes("/actions/runs?"), "checkRunCache", null],
  ["jobs", { type: "CheckSuite", url: "https://api.github.com/repos/example/widgets/actions/runs/123" },
    path => path.includes("/jobs?"), "jobCache", "/repos/example/widgets/actions/runs/123/jobs?filter=latest&per_page=100"],
];

function response(args) {
  const path = args.at(-1);
  if (path === "graphql") return http({ data: { repository: {
    pullRequest: { isInMergeQueue: false },
    discussion: { closed: true, isAnswered: false, stateReason: "RESOLVED" },
  } } });
  if (path.includes("/jobs?")) return http({ total_count: 0, jobs: [] });
  if (path.includes("/actions/runs?")) return http({ total_count: 1, workflow_runs: [workflowRun({ check_suite_id: 7 })] });
  if (path.includes("/check-suites/") || path.includes("/actions/runs/")) return http({ status: "completed", conclusion: "failure" });
  return http({ state: "open", merged: false, draft: false });
}

test("invalidation during a subject request keeps the older successful response due for revalidation", async t => {
  for (const [name, subject, matches, cacheName, endpoint] of cases) {
    for (const warm of [false, true]) {
      await t.test(`${name}, ${warm ? "cached" : "initial"} lookup`, async subtest => {
        let release;
        const held = new Promise(resolve => { release = resolve; });
        let entered;
        const started = new Promise(resolve => { entered = resolve; });
        let hold = false;
        let calls = 0;
        const client = new GitHubClient({ now: () => 1000, run: async args => {
          if (matches(args.at(-1))) {
            calls++;
            if (hold) { entered(); await held; }
          }
          return response(args);
        } });
        const item = normalizeThreads([thread("1", { subject: {
          title: "Synthetic build workflow run failed for main branch", ...subject,
        } })])[0];
        if (warm) {
          await client.refreshSubjects([item]);
          client.invalidateSubjects([item]);
        }
        hold = true;
        const loading = client.refreshSubjects([item]);
        subtest.after(async () => { release(); await loading; });
        await started;
        client.invalidateSubjects([item]);
        release();
        await loading;
        const cache = client[cacheName];
        const key = endpoint ?? cache.keys().next().value;
        assert.equal(cache.get(key).nextRefreshAt, 0);
        assert.equal(client.subjectsNeedRefresh([item]), true);
        const before = calls;
        await client.refreshSubjects([item]);
        assert.equal(calls, before + 1);
        assert.equal(client.subjectsNeedRefresh([item]), false);
      });
    }
  }
});

test("invalidation never bypasses failure backoff or invalidates unrelated pending subjects", async () => {
  for (const failure of [false, true]) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let calls = 0;
    const client = new GitHubClient({ now: () => 1000, run: async () => {
      calls++;
      entered();
      await held;
      return failure ? http({}, {}, 403) : http({ state: "closed" });
    } });
    const item = normalizeThreads([thread("1", { subject: {
      type: "Issue", title: "Synthetic issue", url: "https://api.github.com/repos/example/widgets/issues/1",
    } })])[0];
    const loading = client.refreshSubjects([item]);
    await started;
    client.invalidateSubjects([failure ? item : { ...item, number: "2" }]);
    release();
    await loading;
    assert.equal(client.subjectsNeedRefresh([item]), false);
    if (failure) {
      client.invalidateSubjects([item]);
      assert.equal(client.subjectCache.get("/repos/example/widgets/issues/1").nextRefreshAt, 1000 + RETRY_MS);
    }
    await client.refreshSubjects([item]);
    assert.equal(calls, 1);
  }
});

test("invalidation from another notification also applies to an in-flight shared jobs lookup", async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let hold = false;
  const client = new GitHubClient({ now: () => 1000, run: async args => {
    if (hold && args.at(-1).includes("/jobs?")) { entered(); await held; }
    return response(args);
  } });
  const [suite, direct] = normalizeThreads([cases[3][1], cases[5][1]]
    .map((subject, index) => thread(String(index + 1), { subject: { title: "Synthetic failed run", ...subject } })));
  await client.refreshSubjects([suite, direct]);
  client.invalidateSubjects([suite]);
  hold = true;
  const loading = client.refreshSubjects([suite]);
  t.after(async () => { release(); await loading; });
  await started;
  client.invalidateSubjects([direct]);
  release();
  await loading;
  assert.equal(client.jobCache.get("/repos/example/widgets/actions/runs/123/jobs?filter=latest&per_page=100").nextRefreshAt, 0);
  await client.refreshSubjects([suite, direct]);
  assert.equal(client.subjectsNeedRefresh([suite, direct]), false);
  client.clear();
  assert.equal(client.subjectInvalidations.size, 0);
});
