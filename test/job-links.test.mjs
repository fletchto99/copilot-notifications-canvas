import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, RETRY_MS, SUBJECT_POLL_MS } from "../src/github.mjs";
import { apiTarget, normalizeThreads } from "../src/model.mjs";
import { Inbox } from "../src/inbox.mjs";
import { http, thread, workflowRun, workflowJob } from "./fixtures.mjs";

const runURL = "https://github.com/example/widgets/actions/runs/123";
const jobURL = `${runURL}/job/456`;
const jobsBody = jobs => ({ total_count: jobs.length, jobs });

function fixture({ kind = "inferred", attempt = 1, conclusion = "failure", now = () => 0,
  jobs = [workflowJob({ run_attempt: attempt })], response, baseUrl = "https://api.github.com" } = {}) {
  const target = apiTarget(baseUrl);
  const subject = { type: "CheckSuite",
    title: `Synthetic build workflow run${attempt === 1 ? "" : `, Attempt #${attempt}`} failed for main branch`,
    url: kind === "direct" ? `${baseUrl}/repos/example/widgets/actions/runs/123`
      : kind === "suite" ? `${baseUrl}/repos/example/widgets/check-suites/7` : null };
  const item = normalizeThreads([thread("17", { subject })], target)[0];
  const calls = [];
  const jobCalls = [];
  const client = new GitHubClient({ now, apiBaseUrl: baseUrl, run: async args => {
    calls.push(args);
    assert.ok(args.includes("GET"));
    assert.ok(!args.at(-1).includes("/logs"), "Log contents must never be fetched");
    if (args.at(-1).includes("/jobs?")) {
      jobCalls.push(args);
      return response ? response(args, jobCalls.length) : http(jobsBody(jobs));
    }
    return http(args.at(-1).includes("/actions/runs?") ? {
      total_count: 1, workflow_runs: [workflowRun({ check_suite_id: 7, run_attempt: attempt,
        html_url: `${target.webOrigin}/example/widgets/actions/runs/123` })],
    } : { status: "completed", conclusion });
  } });
  return { client, item, calls, jobCalls };
}

test("inferred, suite and direct runs open the unique failed job with the appropriate provenance", async () => {
  for (const kind of ["inferred", "suite", "direct"]) {
    const { client, item, jobCalls } = fixture({ kind });
    await client.refreshSubjects([item]);
    const snapshot = client.subjectSnapshot(item);
    assert.equal(snapshot.url, jobURL);
    assert.equal(snapshot.subjectLinkTarget, "job");
    assert.equal(snapshot.subjectLinkSource, kind === "inferred" ? "inferred" : undefined);
    assert.equal(snapshot.label, kind === "inferred" ? "Open failed job logs for inferred workflow run" : "Open failed job logs");
    assert.equal(snapshot.subjectState, "failure");
    assert.equal(snapshot.direct, true);
    assert.equal(jobCalls.length, 1);
    assert.equal(jobCalls[0].at(-1), `/repos/example/widgets/actions/runs/123${kind === "inferred" ? "/attempts/1/jobs?" : "/jobs?filter=latest&"}per_page=100`);
    assert.equal(client.subjectsNeedRefresh([item]), false);
    assert.equal(client.sequence, 0);
    client.clear();
    assert.equal(client.jobCache.size, 0);
  }
});

test("inferred job lookups stay pinned to the named attempt and reject a different attempt", async () => {
  for (const actual of [1, 3, 4]) {
    const { client, item, jobCalls } = fixture({ attempt: 3, jobs: [workflowJob({ run_attempt: actual })] });
    await client.refreshSubjects([item]);
    const snapshot = client.subjectSnapshot(item);
    assert.equal(jobCalls[0].at(-1), "/repos/example/widgets/actions/runs/123/attempts/3/jobs?per_page=100");
    assert.equal(snapshot.url, actual === 3 ? jobURL : `${runURL}/attempts/3`);
    if (actual !== 3) assert.match(snapshot.subjectLinkError, /Job logs link unavailable/);
  }
});

test("zero, multiple, or not-yet-final failures keep the run summary instead of choosing a job", async () => {
  for (const jobs of [
    [], [workflowJob({ conclusion: "success" })], [workflowJob({ conclusion: "cancelled" })],
    [workflowJob(), workflowJob({ id: 457, html_url: `${runURL}/job/457` })],
    [workflowJob(), workflowJob({ id: 457, conclusion: "timed_out" })],
    [workflowJob(), workflowJob({ id: 457, status: "in_progress", conclusion: null })],
  ]) {
    const { client, item } = fixture({ jobs });
    await client.refreshSubjects([item]);
    const snapshot = client.subjectSnapshot(item);
    assert.equal(snapshot.url, `${runURL}/attempts/1`);
    assert.equal(snapshot.subjectLinkTarget, undefined);
    assert.equal(snapshot.subjectLinkSource, "inferred");
    assert.equal(snapshot.subjectLinkError, undefined);
  }
});

test("timeouts and startup failures count as failed jobs, while non-failed runs skip the lookup", async () => {
  for (const conclusion of ["failure", "timed_out", "startup_failure"]) {
    const { client, item } = fixture({ kind: "direct", conclusion, jobs: [workflowJob({ conclusion })] });
    await client.refreshSubjects([item]);
    assert.equal(client.subjectSnapshot(item).url, jobURL);
  }
  for (const conclusion of ["success", "neutral", "cancelled", "skipped", "action_required", "stale"]) {
    const { client, item, jobCalls } = fixture({ kind: "direct", conclusion });
    await client.refreshSubjects([item]);
    assert.equal(client.subjectSnapshot(item).url, runURL);
    assert.equal(jobCalls.length, 0);
  }
});

test("incomplete job lists and malformed or unsafe destinations never select a failed job", async () => {
  for (const [body, headers] of [
    [null], [{}], [{ total_count: -1, jobs: [] }], [{ total_count: "1", jobs: [workflowJob()] }],
    [{ total_count: 2, jobs: [workflowJob()] }], [{ total_count: 101, jobs: [workflowJob()] }],
    [jobsBody([workflowJob()]), { link: '<https://api.github.com/next>; rel="next"' }],
    [jobsBody([workflowJob(), workflowJob()])],
    ...[null, {}, workflowJob({ id: 0 }), workflowJob({ id: "../1" }), workflowJob({ id: 9007199254740992 }),
      workflowJob({ run_id: 124 }), workflowJob({ run_id: 9007199254740992 }),
      workflowJob({ run_attempt: 0 }), workflowJob({ run_attempt: undefined }), workflowJob({ run_attempt: "1" }),
      workflowJob({ status: "unknown" }), workflowJob({ conclusion: "unknown" }),
      ...[null, "https://evil.test/run/456", "https://github.com/example/other/actions/runs/123/job/456",
        `${runURL}/job/457`, `${runURL}/job/456?unexpected=true`, `${runURL}/job/456#fragment`,
        "https://secret@github.com/example/widgets/actions/runs/123/job/456"]
        .map(html_url => workflowJob({ html_url })),
    ].map(job => [jobsBody([job])]),
  ]) {
    const { client, item } = fixture({ response: () => http(body, headers) });
    await client.refreshSubjects([item]);
    const snapshot = client.subjectSnapshot(item);
    assert.equal(snapshot.url, `${runURL}/attempts/1`);
    assert.match(snapshot.subjectLinkError, /Job logs link unavailable/);
    assert.equal(snapshot.subjectState, "failure");
    assert.equal(client.subjectsNeedRefresh([item]), false);
  }
});

test("a complete 100-job list can identify a failure without retaining names, steps or response bodies", async () => {
  const jobs = Array.from({ length: 100 }, (_, index) => workflowJob({
    id: String(456 + index), run_id: "123", conclusion: index ? "success" : "failure",
    name: "Private job name", steps: [{ name: "Private step name" }], runner_name: "Private runner",
  }));
  const { client, item } = fixture({ jobs });
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).url, jobURL);
  assert.doesNotMatch(JSON.stringify([...client.jobCache.values()]), /Private|steps|runner/);
  const inbox = new Inbox(client);
  inbox.pages = [{ items: [item], sequence: 1, fetchedAt: 0 }];
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /example\/|Synthetic|subjectLink|job\/456/);
  inbox.close();
});

test("job links share caches, conditionally revalidate, and follow force and notification refreshes", async () => {
  let now = 0;
  const { client, item, jobCalls } = fixture({ now: () => now, response: (_args, count) =>
    count === 2 ? http(null, {}, 304) : http(jobsBody([workflowJob()]), { etag: '"jobs"' }) });
  await Promise.all([client.refreshSubjects([item]), client.refreshSubjects([item])]);
  assert.equal(jobCalls.length, 1);
  now += SUBJECT_POLL_MS;
  assert.equal(client.subjectsNeedRefresh([item]), true);
  await client.refreshSubjects([item]);
  assert.ok(jobCalls[1].includes('If-None-Match: "jobs"'));
  assert.equal(client.subjectSnapshot(item).url, jobURL);
  client.invalidateSubjects([item]);
  await client.refreshSubjects([item]);
  assert.equal(jobCalls.length, 3);
  const changed = { ...item, updatedAt: "2026-01-10T12:01:00Z" };
  await client.refreshSubjects([changed]);
  assert.equal(jobCalls.length, 4);
});

test("failed refreshes discard job links, keep run summaries and honor failure backoff", async () => {
  let now = 0;
  const { client, item, jobCalls } = fixture({ now: () => now, response: (_args, count) =>
    count === 2 ? http({ message: "Private upstream error" }, {}, 403) : http(jobsBody([workflowJob()])) });
  await client.refreshSubjects([item]);
  client.invalidateSubjects([item]);
  await client.refreshSubjects([item]);
  const snapshot = client.subjectSnapshot(item);
  assert.equal(snapshot.url, `${runURL}/attempts/1`);
  assert.match(snapshot.subjectLinkError, /denied access to job details/);
  assert.doesNotMatch(JSON.stringify(snapshot), /Private/);
  assert.equal(client.subjectsNeedRefresh([item]), false);
  client.invalidateSubjects([item]);
  await client.refreshSubjects([item]);
  assert.equal(jobCalls.length, 2);
  now += RETRY_MS;
  await client.refreshSubjects([item]);
  assert.equal(jobCalls.length, 3);
  assert.equal(client.subjectSnapshot(item).url, jobURL);
});

test("a run that becomes successful or inaccessible stops using its cached job link", async () => {
  for (const response of [http({ status: "completed", conclusion: "success" }), http({}, {}, 403)]) {
    const { client, item, jobCalls } = fixture({ kind: "direct" });
    await client.refreshSubjects([item]);
    client.invalidateSubjects([item]);
    client.run = async () => response;
    await client.refreshSubjects([item]);
    assert.equal(client.subjectSnapshot(item).url, runURL);
    assert.equal(client.subjectSnapshot(item).subjectLinkTarget, undefined);
    assert.equal(jobCalls.length, 1);
  }
});

test("development job lookups and destinations remain pinned to the selected host", async () => {
  const baseUrl = "https://api.example.test/rest/v3";
  const expected = "https://api.example.test/example/widgets/actions/runs/123/job/456";
  const { client, item, jobCalls } = fixture({ baseUrl, jobs: [workflowJob({ html_url: expected })] });
  await client.refreshSubjects([item]);
  assert.equal(jobCalls[0][2], "api.example.test");
  assert.equal(jobCalls[0].at(-1), `${baseUrl}/repos/example/widgets/actions/runs/123/attempts/1/jobs?per_page=100`);
  assert.equal(client.subjectSnapshot(item).url, expected);
});

test("job rate limits pause shared requests, and cancellation does not preserve a new job destination", async () => {
  const { client, item, jobCalls } = fixture({ response: () => http({}, { "retry-after": "600" }, 429) });
  await client.refreshSubjects([item]);
  assert.equal(client.blockedUntil, 600_000);
  assert.equal(client.subjectsNeedRefresh([item]), false);
  client.invalidateSubjects([item]);
  await client.refreshSubjects([item]);
  assert.equal(jobCalls.length, 1);
  const controller = new AbortController();
  const interrupted = fixture({ response: () => {
    controller.abort();
    return http(jobsBody([workflowJob()]));
  } });
  await assert.rejects(interrupted.client.refreshSubjects([interrupted.item], controller.signal), { code: "closed" });
  assert.equal(interrupted.client.jobCache.size, 0);
  assert.equal(interrupted.client.subjectSnapshot(interrupted.item).url, `${runURL}/attempts/1`);
});

test("a row removed during run resolution never starts a job lookup", async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { client, item, jobCalls } = fixture();
  const run = client.run;
  client.run = async args => {
    entered();
    await held;
    return run(args);
  };
  let items = [item];
  const loading = client.refreshSubjects(() => items);
  await started;
  items = [];
  release();
  await loading;
  assert.equal(jobCalls.length, 0);
  assert.equal(client.subjectLinkPending(item), true);
  await client.refreshSubjects([item]);
  assert.equal(client.subjectLinkPending(item), false);
});

test("initial CI navigation waits through both run and job resolution but cached refreshes stay ready", async () => {
  for (const kind of ["inferred", "suite", "direct"]) {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const { client, item } = fixture({ kind, response: async () => {
      entered();
      await held;
      return http(jobsBody([workflowJob()]));
    } });
    assert.equal(client.subjectLinkPending(item), true);
    const loading = client.refreshSubjects([item]);
    await started;
    assert.equal(client.subjectLinkPending(item), true, "A run link alone is not the final destination");
    release();
    await loading;
    assert.equal(client.subjectLinkPending(item), false);
    client.invalidateSubjects([item]);
    client.jobCache.clear();
    assert.equal(client.subjectLinkPending(item), false, "Previously ready links stay usable while job metadata refreshes");
    await client.refreshSubjects([item]);
    assert.equal(client.subjectLinkPending(item), false);
    client.clear();
    assert.equal(client.subjectLinksReady.size, 0);
    assert.equal(client.subjectLinkPending(item), true);
  }
});

test("CI fallbacks finish loading on missing matches, errors and backoff instead of staying disabled", async () => {
  for (const kind of ["inferred", "suite", "direct"]) {
    for (const response of [http({}, {}, 403), http(jobsBody([])), http({}, { "retry-after": "600" }, 429)]) {
      const { client, item } = fixture({ kind, response: () => response });
      await client.refreshSubjects([item]);
      assert.equal(client.subjectLinkPending(item), false);
    }
  }
  const { client, item } = fixture();
  client.run = async () => http({ total_count: 0, workflow_runs: [] });
  await client.refreshSubjects([item]);
  assert.equal(client.subjectLinkPending(item), false);
  assert.equal(client.subjectLinkPending({ ...item, title: "Unrecognized workflow title" }), false);
  assert.equal(client.subjectLinkPending({ ...item, type: "Issue" }), false);
  const blocked = fixture();
  blocked.client.blockedUntil = 600_000;
  assert.equal(blocked.client.subjectLinkPending(blocked.item), false);
  assert.equal(blocked.client.subjectLinkPending({ ...blocked.item, runId: "../unsafe" }), false);
});
