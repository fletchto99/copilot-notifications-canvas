import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, SUBJECT_POLL_MS } from "../src/github.mjs";
import { apiTarget, normalizeThreads } from "../src/model.mjs";
import { http, thread } from "./fixtures.mjs";

function suite(url = "https://api.github.com/repos/example/widgets/check-suites/7", baseUrl = "https://api.github.com") {
  return normalizeThreads([thread("17", { subject: { type: "CheckSuite", title: "Synthetic build", url } })], apiTarget(baseUrl))[0];
}
const run = { id: 123, check_suite_id: 7, html_url: "https://github.com/example/widgets/actions/runs/123" };
const result = workflow_runs => ({ total_count: workflow_runs.length, workflow_runs });

test("known suites resolve only their exact workflow run and cache a validated results link", async () => {
  const calls = [];
  const client = new GitHubClient({ run: async args => {
    calls.push(args);
    if (args.at(-1).includes("/jobs?")) return http({ total_count: 0, jobs: [] });
    return http(args.at(-1).includes("/actions/runs?") ? result([run]) : { status: "completed", conclusion: "failure" });
  } });
  const item = suite();
  await client.refreshSubjects([item, item]);
  await client.refreshSubjects([item]);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].at(-1), "/repos/example/widgets/actions/runs?check_suite_id=7&per_page=2");
  assert.ok(calls.every(args => args.includes("GET")));
  const snapshot = client.subjectSnapshot(item);
  assert.equal(snapshot.url, run.html_url);
  assert.equal(snapshot.label, "Open workflow run results");
  assert.equal(snapshot.direct, true);
  assert.equal(snapshot.subjectState, "failure");
  assert.equal(item.number, null);
  client.clear();
  assert.equal(client.checkRunCache.size, 0);
});

test("direct run subjects retain a native results link and use the exact run for status", async () => {
  const item = suite("https://api.github.com/repos/example/widgets/actions/runs/123");
  assert.equal(item.runId, "123");
  assert.equal(item.checkSuiteId, null);
  assert.equal(item.url, run.html_url);
  assert.equal(item.direct, true);
  let calls = 0;
  const client = new GitHubClient({ run: async args => {
    calls++;
    assert.equal(args.at(-1), "/repos/example/widgets/actions/runs/123");
    return http({ status: "completed", conclusion: "success" });
  } });
  await client.refreshSubjects([item]);
  assert.equal(calls, 1);
  assert.equal(client.subjectSnapshot(item).subjectState, "success");
});

test("direct run links and job lookups retain the API-provided attempt through revalidation failures", async () => {
  let now = 0;
  let checks = 0;
  const calls = [];
  const client = new GitHubClient({ now: () => now, run: async args => {
    calls.push(args.at(-1));
    if (args.at(-1).includes("/jobs?")) return http({ total_count: 0, jobs: [] });
    checks++;
    return checks === 1 ? http({ ...run, run_attempt: 2, status: "completed", conclusion: "failure" }, { etag: '"attempt-2"' })
      : checks === 2 ? http(null, {}, 304) : http({}, {}, 503);
  } });
  const item = suite("https://api.github.com/repos/example/widgets/actions/runs/123");
  for (let attempt = 0; attempt < 3; attempt++) {
    await client.refreshSubjects([item]);
    const snapshot = client.subjectSnapshot(item);
    assert.equal(snapshot.url, `${run.html_url}/attempts/2`);
    assert.equal(snapshot.subjectRunUrl, snapshot.url);
    if (attempt === 2) assert.equal(snapshot.subjectStateStale, true);
    now += SUBJECT_POLL_MS;
  }
  assert.ok(calls.includes("/repos/example/widgets/actions/runs/123/attempts/2/jobs?per_page=100"));
  assert.ok(!calls.some(path => path.includes("filter=latest")));
});

test("invalid run identities and attempts cannot become pinned row destinations", async () => {
  for (const body of [
    { ...run, id: 124, run_attempt: 2 },
    ...[0, -1, "2", 9007199254740992].map(run_attempt => ({ ...run, run_attempt })),
  ]) {
    const client = new GitHubClient({ run: async () => http({ status: "completed", conclusion: "failure", ...body }) });
    const item = suite("https://api.github.com/repos/example/widgets/actions/runs/123");
    await client.refreshSubjects([item]);
    assert.equal(client.subjectSnapshot(item).subjectState, null);
    assert.match(client.subjectSnapshot(item).subjectStateError, /workflow run/);
    assert.equal(client.subjectSnapshot(item).url, run.html_url);
  }
});

test("ambiguous, mismatched and unsafe results never replace the Actions fallback", async () => {
  for (const body of [
    result([run, { ...run, id: 124 }]), result([{ ...run, check_suite_id: 8 }]),
    result([{ ...run, id: "javascript:alert(1)" }]), result([{ ...run, id: 9007199254740992 }]),
    ...["https://evil.test/run/123", "https://github.com/example/other/actions/runs/123",
      "https://github.com/example/widgets/actions/runs/123?unsafe=true",
      "https://github.com/example/widgets/actions/runs/123#fragment",
      "https://secret@github.com/example/widgets/actions/runs/123"]
      .map(html_url => result([{ ...run, html_url }])),
    null, {}, { total_count: 2, workflow_runs: [run] },
  ]) {
    const client = new GitHubClient({ run: async args => http(args.at(-1).includes("/actions/runs?")
      ? body : { status: "completed", conclusion: "success" }) });
    const item = suite();
    await client.refreshSubjects([item]);
    const snapshot = { ...item, ...client.subjectSnapshot(item) };
    assert.equal(snapshot.url, "https://github.com/example/widgets/actions");
    assert.equal(snapshot.direct, false);
    assert.equal(snapshot.subjectState, "success");
    assert.match(snapshot.subjectLinkError, /unambiguous/);
  }
});

test("missing and inaccessible run results keep an honest fallback without guessed IDs", async () => {
  for (const response of [http(result([])), http({}, {}, 403)]) {
    const client = new GitHubClient({ run: async args => args.at(-1).includes("/actions/runs?")
      ? response : http({ status: "completed", conclusion: "failure" }) });
    const item = suite();
    await client.refreshSubjects([item]);
    assert.equal({ ...item, ...client.subjectSnapshot(item) }.url, "https://github.com/example/widgets/actions");
  }
  const client = new GitHubClient({ run: async () => assert.fail("Missing suite IDs without a recognized workflow title must not trigger run searches") });
  const item = suite(null);
  await client.refreshSubjects([item]);
  assert.equal(item.url, "https://github.com/example/widgets/actions");
  await assert.rejects(client.request("/repos/example/widgets/issues/7", undefined, "GET",
    { subjectType: "CheckSuite", checkRun: true }), { code: "run_results_unavailable" });
});

test("development run lookups and their links remain pinned to the selected host", async () => {
  const baseUrl = "https://api.example.test/rest/v3";
  const item = suite(`${baseUrl}/repos/example/widgets/check-suites/7`, baseUrl);
  const client = new GitHubClient({ apiBaseUrl: baseUrl, run: async args => {
    assert.equal(args[2], "api.example.test");
    assert.ok(args.at(-1).startsWith(baseUrl));
    return http(args.at(-1).includes("/actions/runs?") ? result([{ ...run,
      html_url: "https://api.example.test/example/widgets/actions/runs/123",
    }]) : { status: "completed", conclusion: "success" });
  } });
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).url, "https://api.example.test/example/widgets/actions/runs/123");
});
