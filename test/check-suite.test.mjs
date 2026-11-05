import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, SUBJECT_POLL_MS } from "../src/github.mjs";
import { apiTarget, normalizeThreads, notificationTitle } from "../src/model.mjs";
import { Inbox } from "../src/inbox.mjs";
import { http, thread } from "./fixtures.mjs";

function suite({ url = "https://api.github.com/repos/example/widgets/check-suites/9007199254740993",
  title = "Synthetic workflow", baseUrl = "https://api.github.com" } = {}) {
  return normalizeThreads([thread("17", { subject: { type: "CheckSuite", title, url } })], apiTarget(baseUrl))[0];
}

test("check suite IDs come only from same-repository API links and are never shown as issue or run numbers", async () => {
  const item = suite();
  assert.equal(item.checkSuiteId, "9007199254740993");
  assert.equal(item.number, null);
  assert.equal(notificationTitle(item), "Synthetic workflow");
  assert.equal(item.url, "https://github.com/example/widgets/actions");
  const calls = [];
  const client = new GitHubClient({ now: () => 0, run: async args => {
    calls.push(args);
    if (args.at(-1).includes("/actions/runs?")) return http({ total_count: 0, workflow_runs: [] });
    return http({ status: "completed", conclusion: "failure", head_commit: { message: "Private commit text" } });
  } });
  await client.refreshSubjects([item]);
  assert.equal(calls[0].at(-1), "/repos/example/widgets/check-suites/9007199254740993");
  assert.ok(calls[0].includes("GET"));
  assert.deepEqual(client.subjectSnapshot(item), {
    subjectState: "failure", subjectStateError: null, subjectCheckedAt: 0, subjectStateStale: false,
  });
  assert.doesNotMatch(JSON.stringify([...client.subjectCache.values()]), /Private/);
});

test("check suite status and conclusion stay distinct, including pending and non-passing outcomes", async () => {
  const cases = [
    ...["queued", "in_progress", "waiting", "requested", "pending"].flatMap(status =>
      [null, "failure", "success"].map(conclusion => [{ status, conclusion }, status])),
    ...["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "startup_failure", "stale"]
      .map(conclusion => [{ status: "completed", conclusion }, conclusion]),
  ];
  for (const [body, expected] of cases) {
    const client = new GitHubClient({ run: async () => http(body) });
    await client.refreshSubjects([suite()]);
    assert.equal(client.subjectSnapshot(suite()).subjectState, expected);
    assert.equal(client.subjectSnapshot(suite()).subjectStateError, null);
  }
  for (const body of [null, {}, { status: null, conclusion: null }, { status: "completed", conclusion: null },
    { status: "unknown", conclusion: "success" }, { status: "completed", conclusion: "unknown" }]) {
    const client = new GitHubClient({ run: async () => http(body) });
    await client.refreshSubjects([suite()]);
    assert.equal(client.subjectSnapshot(suite()).subjectState, null);
    assert.match(client.subjectSnapshot(suite()).subjectStateError, /supported check suite/);
  }
});

test("missing links use only recognized reported workflow results, without fetching or claiming live status", async () => {
  const client = new GitHubClient({ run: async () => assert.fail("Unlinked notification must not fetch status") });
  for (const [result, expected] of [
    ["succeeded", "success"], ["failed", "failure"], ["cancelled", "cancelled"],
    ["timed out", "timed_out"], ["skipped", "skipped"],
  ]) {
    const item = suite({ url: null, title: `Synthetic build workflow run ${result} for feature/test` });
    await client.refreshSubjects([item]);
    assert.deepEqual(client.subjectSnapshot(item), { subjectState: expected, subjectStateError: null, subjectStateSource: "notification" });
  }
  for (const title of [
    "Synthetic build failed", "Synthetic build workflow run completed for main", "Synthetic build workflow run succeeded",
    "Synthetic build workflow run unknown for failed-branch", "Synthetic build workflow run failure for main",
    "Synthetic build\nworkflow run failed for main",
  ]) {
    assert.equal(client.subjectSnapshot(suite({ url: null, title })).subjectState, null);
  }
  assert.equal(client.subjectSnapshot(suite({ url: null, title: "failed build workflow run succeeded for fix/failed-test" })).subjectState, "success");
  assert.equal(client.subjectCache.size, 0);
});

test("invalid check suite URLs never fetch arbitrary hosts, malformed runs, or issue endpoints", async () => {
  const client = new GitHubClient({ run: async () => assert.fail("Unsafe suite lookup") });
  for (const url of [
    null, "https://evil.test/repos/example/widgets/check-suites/7",
    "https://api.github.com/repos/example/other/check-suites/7",
    "https://api.github.com/repos/example/widgets/check-suites/7?token=bad",
    "https://api.github.com/repos/example/widgets/check-suites/7#bad",
    "https://secret@api.github.com/repos/example/widgets/check-suites/7",
    "https://api.github.com/repos/example/widgets/actions/runs/7/jobs",
    "https://api.github.com/repos/example/widgets/issues/7",
    "https://api.github.com/repos/example/widgets/check-suites/0",
    "https://api.github.com/repos/example/widgets/check-suites/07",
    "https://api.github.com/repos/example/widgets/check-suites/7/check-runs",
  ]) {
    const item = suite({ url });
    assert.equal(item.checkSuiteId, null);
    await client.refreshSubjects([item]);
    assert.equal(client.subjectSnapshot(item).subjectState, null);
  }
  await client.refreshSubjects([{ ...suite(), checkSuiteId: "../7" }]);
});

test("check suite refresh is cached, revalidates ETags, and never replaces an API failure with a title guess", async () => {
  let now = 0;
  const calls = [];
  const item = suite({ title: "Synthetic build workflow run failed for main" });
  const client = new GitHubClient({ now: () => now, run: async args => {
    if (args.at(-1).includes("/actions/runs?")) return http({ total_count: 0, workflow_runs: [] });
    calls.push(args);
    return calls.length === 1 ? http({ status: "completed", conclusion: "success" }, { etag: '"suite"' }) :
      calls.length === 2 ? http(null, {}, 304) : http({}, {}, 404);
  } });
  await client.refreshSubjects([item, item]);
  await client.refreshSubjects([item]);
  assert.equal(calls.length, 1);
  assert.equal(client.subjectSnapshot(item).subjectState, "success");
  now += SUBJECT_POLL_MS;
  await client.refreshSubjects([item]);
  assert.ok(calls[1].includes('If-None-Match: "suite"'));
  assert.equal(client.subjectSnapshot(item).subjectState, "success");
  client.invalidateSubjects([item]);
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).subjectState, "success");
  assert.equal(client.subjectSnapshot(item).subjectStateStale, true);
  assert.match(client.subjectSnapshot(item).subjectStateError, /denied access/);
});

test("custom API check suite lookups stay on their selected host and subject details stay out of agent summaries", async () => {
  const baseUrl = "https://api.example.test/rest/v3";
  const item = suite({ baseUrl, url: `${baseUrl}/repos/example/widgets/check-suites/7` });
  const client = new GitHubClient({ apiBaseUrl: baseUrl, run: async args => {
    assert.equal(args[2], "api.example.test");
    if (args.at(-1).includes("/actions/runs?")) {
      assert.equal(args.at(-1), `${baseUrl}/repos/example/widgets/actions/runs?check_suite_id=7&per_page=2`);
      return http({ total_count: 0, workflow_runs: [] });
    }
    assert.equal(args.at(-1), `${baseUrl}/repos/example/widgets/check-suites/7`);
    return http({ status: "completed", conclusion: "failure" });
  } });
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).subjectState, "failure");
  const inbox = new Inbox(client);
  inbox.pages = [{ items: [item], sequence: 1, fetchedAt: 0 }];
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /checkSuiteId|subjectState|failure|example\/|Synthetic workflow/);
  inbox.close();
});
