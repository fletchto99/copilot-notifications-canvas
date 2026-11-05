import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, RETRY_MS, SUBJECT_POLL_MS } from "../src/github.mjs";
import { apiTarget, normalizeThreads, reportedWorkflow } from "../src/model.mjs";
import { Inbox } from "../src/inbox.mjs";
import { http, thread, workflowRun } from "./fixtures.mjs";

const title = "Synthetic build workflow run failed for main branch";
const results = workflow_runs => ({ total_count: workflow_runs.length, workflow_runs });
function notification(overrides = {}, baseUrl) {
  return normalizeThreads([thread("17", {
    subject: { type: "CheckSuite", title, url: null }, ...overrides,
  })], apiTarget(baseUrl))[0];
}
const filteredURL = notification().url;

function matchingClient(options) {
  return new GitHubClient({ ...options, run: (args, context) => args.at(-1).includes("/jobs?")
    ? Promise.resolve(http({ total_count: 0, jobs: [] })) : options.run(args, context) });
}

test("recognized workflow titles supply bounded, safely encoded Actions filters without interpreting IDs", () => {
  const item = notification();
  assert.equal(new URL(item.url).searchParams.get("query"), 'workflow:"Synthetic build" branch:"main" is:failure');
  assert.equal(item.label, "Open filtered repository Actions");
  assert.equal(item.number, null);
  assert.equal(item.direct, false);
  const parsed = reportedWorkflow("Synthetic build workflow run, Attempt #3 failed at startup for feature/fix branch");
  assert.deepEqual(parsed, { name: "Synthetic build", branch: "feature/fix", attempt: 3, state: "startup_failure" });
  assert.equal(reportedWorkflow("Synthetic build workflow run failed for main").branch, null);
  assert.equal(reportedWorkflow(null), null);
  for (const [name, branch] of [
    ["Synthetic build", "fix/a&b#c"], ["Synthetic & build", "feature/a+b"],
  ]) {
    const item = notification({ subject: { type: "CheckSuite", title: `${name} workflow run failed for ${branch} branch`, url: null } });
    const url = new URL(item.url);
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.hash, "");
    assert.deepEqual([...url.searchParams.keys()], ["query"]);
    assert.equal(url.searchParams.get("query"), `workflow:"${name}" branch:"${branch}" is:failure`);
  }
  const startup = notification({ subject: { type: "CheckSuite",
    title: "Synthetic build workflow run, Attempt #3 failed at startup for main branch", url: null } });
  assert.match(new URL(startup.url).searchParams.get("query"), /is:failure$/);
});

test("unknown or unsafe title formats retain reported status where possible but never broaden a search", async () => {
  const client = matchingClient({ run: async () => assert.fail("Unrecognized titles must not search") });
  for (const value of [
    "Unstructured title", "Synthetic build workflow run failed for main",
    'Bad "name workflow run failed for main branch', "Bad\\name workflow run failed for main branch",
    "Bad\u0000name workflow run failed for main branch",
    'Synthetic build workflow run failed for main" is:success branch',
    "Synthetic build workflow run failed for bad\u0000branch branch",
    "Synthetic build workflow run failed for two words branch",
    "Synthetic build workflow run failed for  branch",
    `Synthetic build workflow run failed for ${"b".repeat(256)} branch`,
    `${"a".repeat(257)} workflow run failed for main branch`,
    "Synthetic build workflow run, Attempt #9007199254740992 failed for main branch",
  ]) {
    const item = notification({ subject: { type: "CheckSuite", title: value, url: null } });
    assert.equal(item.url, "https://github.com/example/widgets/actions");
    assert.equal(client.subjectsNeedRefresh([item]), false);
    await client.refreshSubjects([item]);
    assert.equal(client.subjectSnapshot(item).subjectLinkSource, undefined);
  }
  for (const item of [
    { ...notification(), repository: "../other" },
    { ...notification(), updatedAt: "invalid" },
    { ...notification(), updatedAt: "+275760-09-13T00:00:00.000Z" },
    { ...notification(), updatedAt: "-271821-04-20T00:00:00.000Z" },
  ]) {
    await client.refreshSubjects([item]);
    assert.equal(client.subjectsNeedRefresh([item]), false);
  }
});

test("a unique nearby workflow run produces an explicitly inferred attempt link, never live status", async () => {
  const calls = [];
  const client = matchingClient({ now: () => 0, run: async args => {
    calls.push(args);
    return http(results([workflowRun({ head_commit: { message: "Private upstream body" } })]));
  } });
  const item = notification();
  assert.equal(client.subjectsNeedRefresh([item]), true);
  await Promise.all([client.refreshSubjects([item, item]), client.refreshSubjects([item])]);
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args[2], "github.com");
  assert.ok(args.includes("GET"));
  const url = new URL(args.at(-1), "https://api.github.com");
  assert.equal(url.pathname, "/repos/example/widgets/actions/runs");
  assert.equal(url.searchParams.get("branch"), "main");
  assert.equal(url.searchParams.get("created"), "2026-01-03T12:00:00.000Z..2026-01-10T12:02:00.000Z");
  assert.equal(url.searchParams.get("per_page"), "100");
  assert.deepEqual([...url.searchParams.keys()], ["branch", "created", "per_page"]);
  assert.deepEqual(client.subjectSnapshot(item), {
    subjectState: "failure", subjectStateError: null, subjectStateSource: "notification",
    url: "https://github.com/example/widgets/actions/runs/123/attempts/1",
    label: "Open inferred workflow run results", direct: true, subjectLinkSource: "inferred",
  });
  assert.equal(client.subjectsNeedRefresh([item]), false);
  assert.equal(client.sequence, 0);
  assert.equal(client.subjectCache.size, 0);
  assert.doesNotMatch(JSON.stringify([...client.checkRunCache.values()]), /Private|head_commit/);
  const inbox = new Inbox(client);
  inbox.pages = [{ items: [item], sequence: 1, fetchedAt: 0 }];
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /example\/|Synthetic|subjectLink|actions\/runs|attempt/);
  inbox.close();
  client.clear();
  assert.equal(client.checkRunCache.size, 0);
});

test("attempts and every recognized outcome match exactly and remain pinned to their attempt", async () => {
  for (const [outcome, conclusion] of [
    ["succeeded", "success"], ["failed", "failure"], ["cancelled", "cancelled"],
    ["timed out", "timed_out"], ["skipped", "skipped"], ["failed at startup", "startup_failure"],
  ]) {
    const item = notification({ subject: { type: "CheckSuite",
      title: `Synthetic build workflow run, Attempt #3 ${outcome} for main branch`, url: null } });
    const client = matchingClient({ run: async () => http(results([workflowRun({ run_attempt: 3, conclusion })])) });
    await client.refreshSubjects([item]);
    assert.match(client.subjectSnapshot(item).url, /\/attempts\/3$/);
    assert.equal(client.subjectSnapshot(item).subjectState, conclusion);
  }
});

test("matching never picks the latest or closest run, ignores a conflict, or confuses names and attempts", async () => {
  const other = workflowRun({ id: 124, html_url: "https://github.com/example/widgets/actions/runs/124" });
  for (const runs of [
    [], [workflowRun({ name: "Different build" })], [workflowRun({ head_branch: "other" })],
    [workflowRun({ status: "in_progress" })], [workflowRun({ conclusion: "success" })],
    [workflowRun({ run_attempt: 2 })], [workflowRun({ run_attempt: "1" })], [workflowRun({ run_attempt: undefined })],
    [workflowRun({ updated_at: "2026-01-10T12:02:01Z" })],
    [workflowRun({ created_at: "2026-01-10T11:00:00Z", updated_at: "2026-01-10T11:57:59Z" })],
    [workflowRun(), other],
    [workflowRun(), { ...other, conclusion: "success", updated_at: "2026-01-10T12:00:00Z" }],
    [workflowRun(), { ...other, run_attempt: 2 }],
    [workflowRun(), workflowRun()],
  ]) {
    const item = notification();
    const client = matchingClient({ run: async () => http(results(runs)) });
    await client.refreshSubjects([item]);
    const snapshot = { ...item, ...client.subjectSnapshot(item) };
    assert.equal(snapshot.url, filteredURL);
    assert.equal(snapshot.direct, false);
    assert.equal(snapshot.subjectState, "failure");
    assert.equal(snapshot.subjectLinkSource, undefined);
    assert.equal(client.subjectsNeedRefresh([item]), false);
  }
});

test("matching requires a complete bounded response and rejects unsafe run destinations", async () => {
  for (const [body, headers] of [
    [null], [{}], [{ total_count: -1, workflow_runs: [] }], [{ total_count: "1", workflow_runs: [workflowRun()] }],
    [{ total_count: 2, workflow_runs: [workflowRun()] }], [{ total_count: 101, workflow_runs: [workflowRun()] }],
    [results([workflowRun()]), { link: '<https://api.github.com/next>; rel="next"' }],
    ...[null, {}, { name: "Synthetic build" }, { head_branch: "main" },
      workflowRun({ updated_at: null }), workflowRun({ created_at: "invalid" }),
      workflowRun({ created_at: "2026-01-10T12:01:00Z" }),
      workflowRun({ created_at: "2026-01-03T11:59:59Z" }),
      workflowRun({ created_at: "2026-01-10T12:02:01Z", updated_at: "2026-01-10T12:02:01Z" }),
      workflowRun({ id: 0 }), workflowRun({ id: 9007199254740992 }), workflowRun({ id: "../1" }),
      ...["https://evil.test/run/123", "https://github.com/example/other/actions/runs/123",
        "https://github.com/example/widgets/actions/runs/123?unexpected=true",
        "https://github.com/example/widgets/actions/runs/123#fragment",
        "https://secret@github.com/example/widgets/actions/runs/123"]
        .map(html_url => workflowRun({ html_url })),
    ].map(run => [results([run])]),
  ]) {
    const item = notification();
    const client = matchingClient({ run: async () => http(body, headers) });
    await client.refreshSubjects([item]);
    const snapshot = { ...item, ...client.subjectSnapshot(item) };
    assert.equal(snapshot.url, filteredURL);
    assert.match(snapshot.subjectLinkError, /Run results link unavailable/);
    assert.equal(snapshot.subjectState, "failure");
    assert.equal(client.subjectsNeedRefresh([item]), false);
  }
});

test("two-minute timing and seven-day search boundaries are inclusive, and 100 complete results are accepted", async () => {
  for (const updated_at of ["2026-01-10T11:58:00Z", "2026-01-10T12:02:00Z"]) {
    const client = matchingClient({ run: async () => http(results([
      workflowRun({ created_at: "2026-01-03T12:00:00Z", updated_at }),
      ...Array.from({ length: 99 }, (_, index) => workflowRun({ name: `Unrelated workflow ${index}` })),
    ])) });
    await client.refreshSubjects([notification()]);
    assert.equal(client.subjectSnapshot(notification()).subjectLinkSource, "inferred");
  }
  const client = matchingClient({ run: async () => http(results([
    workflowRun({ created_at: "2026-01-10T12:02:00Z", updated_at: "2026-01-10T12:02:00Z",
      id: "9007199254740993", html_url: "https://github.com/example/widgets/actions/runs/9007199254740993" }),
  ])) });
  await client.refreshSubjects([notification()]);
  assert.match(client.subjectSnapshot(notification()).url, /9007199254740993\/attempts\/1$/);
});

test("matching shares conditional caches but isolates different titles, timestamps and repositories", async () => {
  let now = 0;
  const calls = [];
  const client = matchingClient({ now: () => now, run: async args => {
    calls.push(args);
    return calls.length === 2 ? http(null, {}, 304) : http(results([workflowRun()]), { etag: '"runs"' });
  } });
  const item = notification();
  await client.refreshSubjects([item]);
  now += SUBJECT_POLL_MS;
  assert.equal(client.subjectsNeedRefresh([item]), true);
  await client.refreshSubjects([item]);
  assert.ok(calls[1].includes('If-None-Match: "runs"'));
  assert.equal(client.subjectSnapshot(item).subjectLinkSource, "inferred");
  for (const changed of [
    { ...item, title: title.replace("Synthetic build", "Different build") },
    { ...item, title: title.replace("failed", "succeeded") },
    { ...item, title: title.replace("workflow run", "workflow run, Attempt #2") },
    { ...item, updatedAt: "2026-01-10T12:01:00.000Z" },
    { ...item, repository: "example/other" },
  ]) {
    assert.equal(client.subjectSnapshot(changed).url, undefined);
    assert.equal(client.subjectsNeedRefresh([changed]), true);
  }
  client.invalidateSubjects([item]);
  await client.refreshSubjects([item]);
  assert.equal(calls.length, 3);
});

test("failed refreshes discard inferred destinations, sanitize errors and honor backoff before retry", async () => {
  let now = 0;
  let calls = 0;
  const client = matchingClient({ now: () => now, run: async () => {
    calls++;
    return calls === 1 || calls === 3 ? http(results([workflowRun()])) : http({ message: "Private response" }, {}, 403);
  } });
  const item = notification();
  await client.refreshSubjects([item]);
  client.invalidateSubjects([item]);
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).url, undefined);
  assert.match(client.subjectSnapshot(item).subjectLinkError, /denied access to workflow runs/);
  assert.doesNotMatch(JSON.stringify(client.subjectSnapshot(item)), /Private/);
  assert.equal(client.subjectsNeedRefresh([item]), false);
  client.invalidateSubjects([item]);
  await client.refreshSubjects([item]);
  assert.equal(calls, 2);
  now += RETRY_MS;
  await client.refreshSubjects([item]);
  assert.equal(calls, 3);
  assert.equal(client.subjectSnapshot(item).subjectLinkSource, "inferred");
});

test("rate limits and aborts constrain inferred searches without notification writes", async () => {
  let calls = 0;
  const client = matchingClient({ now: () => 0, run: async args => {
    calls++;
    assert.ok(args.includes("GET"));
    return http({ message: "Private rate limit detail" }, { "retry-after": "600" }, 429);
  } });
  const item = notification();
  await client.refreshSubjects([item]);
  assert.equal(client.blockedUntil, 600_000);
  assert.equal(client.subjectsNeedRefresh([item]), false);
  client.invalidateSubjects([item]);
  await client.refreshSubjects([item]);
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.refreshSubjects([item], controller.signal), { code: "closed" });
  const active = new AbortController();
  const interrupted = matchingClient({ run: async () => {
    active.abort();
    return http(results([workflowRun()]));
  } });
  await assert.rejects(interrupted.refreshSubjects([item], active.signal), { code: "closed" });
  assert.equal(interrupted.checkRunCache.size, 0);
});

test("development matching remains on its selected API and web origin", async () => {
  const baseUrl = "https://api.example.test/rest/v3";
  const item = notification({}, baseUrl);
  const client = matchingClient({ apiBaseUrl: baseUrl, run: async args => {
    assert.equal(args[2], "api.example.test");
    assert.ok(args.at(-1).startsWith(`${baseUrl}/repos/example/widgets/actions/runs?`));
    return http(results([workflowRun({ html_url: "https://api.example.test/example/widgets/actions/runs/123" })]));
  } });
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).url, "https://api.example.test/example/widgets/actions/runs/123/attempts/1");
  assert.equal(new URL(item.url).origin, "https://api.example.test");
});

test("selection changes drop pending run matches after in-flight lookups finish", async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const calls = [];
  let items = Array.from({ length: 25 }, (_, index) => ({
    ...notification(), id: String(index + 1), title: title.replace("Synthetic build", `Synthetic build ${index}`),
  }));
  const client = matchingClient({ run: async args => {
    calls.push(args.at(-1));
    if (calls.length === 20) entered();
    await held;
    return http(results([workflowRun()]));
  } });
  const loading = client.refreshSubjects(() => items);
  await started;
  items = [];
  release();
  await loading;
  assert.equal(calls.length, 20);
});
