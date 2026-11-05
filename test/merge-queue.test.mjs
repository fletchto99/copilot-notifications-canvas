import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, firstPage, RETRY_MS, SUBJECT_POLL_MS } from "../src/github.mjs";
import { apiTarget, normalizeThreads } from "../src/model.mjs";
import { http, thread } from "./fixtures.mjs";

const queueResponse = state => http({ data: { repository: { pullRequest: { isInMergeQueue: state } } } });
const openPR = { state: "open", merged: false, draft: false };
const item = (baseUrl = "https://api.github.com") => normalizeThreads([thread()], apiTarget(baseUrl))[0];

test("open PRs use a read-only parameterized GraphQL query and share cached queue membership", async () => {
  let now = 0;
  let queued = true;
  const calls = [];
  const client = new GitHubClient({ now: () => now, run: async args => {
    calls.push(args);
    return args.at(-1) === "graphql" ? queueResponse(queued) : http(openPR, { etag: '"pull"' });
  } });
  const subject = item();
  await Promise.all([client.refreshSubjects([subject]), client.refreshSubjects([subject])]);
  assert.equal(calls.length, 2);
  assert.equal(client.subjectSnapshot(subject).subjectState, "merge_queued");
  assert.deepEqual(calls[1].slice(0, 7), ["api", "--hostname", "github.com", "--method", "POST", "--include", "-H"]);
  assert.equal(calls[1].at(-1), "graphql", "gh needs the literal endpoint to encode fields as GraphQL variables");
  assert.ok(calls[1].includes("owner=example"));
  assert.ok(calls[1].includes("name=widgets"));
  assert.ok(calls[1].includes("number=42"));
  assert.match(calls[1].find(arg => arg.startsWith("query=")), /^query=query\(\$owner:String!,\$name:String!,\$number:Int!\)/);
  assert.doesNotMatch(calls[1].join(" "), /mutation|enqueuePullRequest|dequeuePullRequest/);
  assert.equal(client.sequence, 0);
  queued = false;
  now += SUBJECT_POLL_MS - 1;
  await client.refreshSubjects([subject]);
  assert.equal(client.subjectSnapshot(subject).subjectState, "merge_queued");
  now++;
  await client.refreshSubjects([subject]);
  assert.equal(client.subjectSnapshot(subject).subjectState, "open");
  queued = true;
  client.invalidateSubjects([subject]);
  await client.refreshSubjects([subject]);
  assert.equal(client.subjectSnapshot(subject).subjectState, "merge_queued");
  const newer = { ...subject, updatedAt: "2026-03-01T00:00:00.000Z" };
  await client.refreshSubjects([newer]);
  const count = calls.length;
  await client.refreshSubjects([subject, newer]);
  assert.equal(calls.length, count);
  client.clear();
  assert.equal(client.mergeQueueCache.size, 0);
});

test("closed, merged, draft, or unavailable PRs never query merge queue membership", async () => {
  for (const body of [
    { ...openPR, state: "closed" }, { ...openPR, state: "closed", merged: true },
    { ...openPR, draft: true }, {},
  ]) {
    const client = new GitHubClient({ run: async args => {
      assert.notEqual(args.at(-1), "graphql");
      return http(body);
    } });
    await client.refreshSubjects([item()]);
  }
});

test("foreground requests can run between a PR state lookup and its merge queue lookup", async () => {
  let release;
  let started;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const calls = [];
  const client = new GitHubClient({ run: async args => {
    const endpoint = args.at(-1);
    calls.push(endpoint);
    if (endpoint.startsWith("/notifications")) return http([thread()]);
    if (endpoint === "graphql") return queueResponse(true);
    started();
    await held;
    return http(openPR);
  } });
  const subjects = client.refreshSubjects([item()]);
  await entered;
  const foreground = client.page(firstPage());
  release();
  await Promise.all([subjects, foreground]);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /\/pulls\/42$/);
  assert.match(calls[1], /^\/notifications\?/);
  assert.equal(calls[2], "graphql");
});

test("queue access errors and malformed GraphQL data keep the known REST state and sanitize error details", async () => {
  for (const response of [
    http({}, {}, 403), http({}, {}, 404), http(null, {}, 304),
    http({ errors: [{ message: "Private upstream text" }], data: { repository: { pullRequest: { isInMergeQueue: true } } } }),
    http({ data: { repository: null } }), http({ data: { repository: { pullRequest: null } } }),
    queueResponse("yes"), http(null), "HTTP/2 200 OK\r\n\r\nnot JSON",
  ]) {
    let now = 0;
    let graphCalls = 0;
    const client = new GitHubClient({ now: () => now, run: async args => {
      if (args.at(-1).startsWith("/notifications")) return http([thread()]);
      if (args.at(-1) !== "graphql") return http(openPR);
      graphCalls++;
      return graphCalls === 1 ? response : queueResponse(true);
    } });
    const subject = item();
    await client.refreshSubjects([subject]);
    assert.equal(client.subjectSnapshot(subject).subjectState, "open");
    assert.ok(client.subjectSnapshot(subject).subjectStateError);
    assert.doesNotMatch(JSON.stringify(client.subjectSnapshot(subject)), /Private/);
    assert.equal(client.blockedUntil, 0);
    client.invalidateSubjects([subject]);
    await client.refreshSubjects([subject]);
    assert.equal(graphCalls, 1);
    assert.equal((await client.page(firstPage())).items.length, 1);
    now += RETRY_MS;
    await client.refreshSubjects([subject]);
    assert.equal(client.subjectSnapshot(subject).subjectState, "merge_queued");
    assert.equal(client.subjectSnapshot(subject).subjectStateError, null);
  }
});

test("GraphQL secondary limits and cancellation preserve shared backoff and abort behavior", async () => {
  for (const response of [
    http({ errors: [{ type: "RATE_LIMITED", message: "Secondary rate limit: private detail" }] }),
    http({}, { "retry-after": "700" }, 429),
  ]) {
    let now = 0;
    let calls = 0;
    const client = new GitHubClient({ now: () => now, run: async args => {
      calls++;
      return args.at(-1) === "graphql" ? response : http(openPR);
    } });
    await client.refreshSubjects([item()]);
    assert.equal(client.subjectSnapshot(item()).subjectState, "open");
    assert.equal(client.serverBlockedUntil, client.blockedUntil);
    await assert.rejects(client.page(firstPage(), undefined, { force: true }), { code: "rate_limited" });
    assert.equal(calls, 2);
    now = client.blockedUntil;
    client.run = async args => args.at(-1) === "graphql" ? queueResponse(true) : http(openPR);
    await client.refreshSubjects([item()]);
    assert.equal(client.subjectSnapshot(item()).subjectState, "merge_queued");
  }
  const controller = new AbortController();
  const client = new GitHubClient({ run: async args => {
    if (args.at(-1) !== "graphql") return http(openPR);
    controller.abort();
    return queueResponse(true);
  } });
  await assert.rejects(client.refreshSubjects([item()], controller.signal), { code: "closed" });
  assert.equal(client.mergeQueueCache.size, 0);
});

test("primary GraphQL limits pause queue checks without blocking REST polling or read/done writes", async () => {
  for (const response of [
    http({ errors: [{ type: "RATE_LIMITED", message: "Private primary limit detail" }] }),
    http({ errors: [{ type: "RATE_LIMITED" }] }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "900" }),
    http({}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "900" }, 403),
  ]) {
    let now = 0;
    let graphCalls = 0;
    const writes = [];
    const client = new GitHubClient({ now: () => now, sleep: async ms => { now += ms; }, run: async args => {
      if (args.at(-1) === "graphql") return ++graphCalls === 1 ? response : queueResponse(true);
      if (args.includes("PATCH") || args.includes("DELETE")) {
        writes.push(args.at(-1));
        return `HTTP/2 ${args.includes("PATCH") ? 205 : 204} Synthetic\r\n\r\n`;
      }
      return args.at(-1).startsWith("/notifications") ? http([thread()]) : http(openPR);
    } });
    const first = item();
    const second = { ...first, id: "2", number: "43" };
    await client.refreshSubjects([first]);
    assert.equal(client.blockedUntil, 0);
    assert.equal(client.serverBlockedUntil, 0);
    assert.ok(client.graphqlBlockedUntil >= RETRY_MS);
    assert.match(client.subjectSnapshot(first).subjectStateError, /GraphQL rate limit/);
    assert.doesNotMatch(JSON.stringify(client.subjectSnapshot(first)), /Private/);
    await client.refreshSubjects([second]);
    assert.equal(graphCalls, 1);
    assert.equal(client.subjectSnapshot(second).subjectState, "open");
    assert.match(client.subjectSnapshot(second).subjectStateError, /GraphQL rate limit/);
    assert.equal(client.subjectsNeedRefresh([first, second]), false);
    assert.equal((await client.page(firstPage(), undefined, { force: true })).items.length, 1);
    await client.markRead("1");
    await client.markDone("2");
    assert.deepEqual(writes, ["/notifications/threads/1", "/notifications/threads/2"]);
    await assert.rejects(client.request("/repos/example/widgets/pulls/99", undefined, "GET",
      { subjectType: "PullRequest", mergeQueue: true }), { code: "graphql_rate_limited", retryAt: client.graphqlBlockedUntil });
    client.invalidateSubjects([first, second]);
    await client.refreshSubjects([first, second]);
    assert.equal(graphCalls, 1);
    now = client.graphqlBlockedUntil;
    await client.refreshSubjects([first, second]);
    assert.equal(graphCalls, 3);
    assert.equal(client.subjectSnapshot(first).subjectState, "merge_queued");
    assert.equal(client.subjectSnapshot(second).subjectStateError, null);
    assert.equal(client.graphqlLastError, null);
  }
});

test("a successful GraphQL response exhausting its primary quota keeps REST available", async () => {
  let graphCalls = 0;
  const client = new GitHubClient({ now: () => 0, run: async args => {
    if (args.at(-1) === "graphql") {
      graphCalls++;
      return http({ data: { repository: { pullRequest: { isInMergeQueue: true } } } },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "900" });
    }
    return args.at(-1).startsWith("/notifications") ? http([thread()]) : http(openPR);
  } });
  const first = item();
  await client.refreshSubjects(Array.from({ length: 25 }, (_, index) => ({ ...first, number: String(index + 42) })));
  assert.equal(graphCalls, 20, "Already in-flight GraphQL queries finish, but no new queries start");
  assert.equal(client.blockedUntil, 0);
  assert.equal(client.serverBlockedUntil, 0);
  assert.equal(client.graphqlBlockedUntil, 901_000);
  assert.equal(client.subjectSnapshot(first).subjectState, "merge_queued");
  assert.equal(client.subjectSnapshot(first).subjectStateStale, false);
  assert.equal(client.subjectsNeedRefresh([first]), false);
  assert.equal((await client.page(firstPage())).items.length, 1);
});

test("GraphQL authentication and secondary limits still block REST, even with exhausted primary headers", async () => {
  for (const [response, code] of [
    [http({}, {}, 401), "authentication"],
    [http({ message: "secondary rate limit" }, {}, 403), "rate_limited"],
    [http({ errors: [{ type: "RATE_LIMITED" }] }, { "retry-after": "700" }), "rate_limited"],
    [http({ errors: [{ message: "secondary rate limit" }] }), "rate_limited"],
    [http({ message: "secondary rate limit" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "900" }, 403), "rate_limited"],
  ]) {
    let calls = 0;
    const client = new GitHubClient({ now: () => 0, run: async args => {
      calls++;
      return args.at(-1) === "graphql" ? response : http(openPR);
    } });
    await client.refreshSubjects([item()]);
    assert.ok(client.blockedUntil >= RETRY_MS);
    assert.equal(client.serverBlockedUntil, code === "authentication" ? 0 : client.blockedUntil);
    assert.equal(client.graphqlBlockedUntil, 0);
    await assert.rejects(client.page(firstPage()), { code });
    await assert.rejects(client.markRead("1"), { code });
    assert.equal(calls, 2);
  }
});

test("merge queue lookups cannot escape custom REST APIs or coerce oversized PR numbers", async () => {
  const baseUrl = "https://api.example.test/rest/v3";
  const subject = normalizeThreads([thread("1", { subject: {
    type: "PullRequest", title: "Synthetic PR", url: `${baseUrl}/repos/example/widgets/pulls/42`,
  } })], apiTarget(baseUrl))[0];
  const client = new GitHubClient({ apiBaseUrl: baseUrl, run: async args => {
    assert.equal(args.at(-1), `${baseUrl}/repos/example/widgets/pulls/42`);
    return http(openPR);
  } });
  await client.refreshSubjects([subject]);
  assert.equal(client.subjectSnapshot(subject).subjectState, "open");
  assert.match(client.subjectSnapshot(subject).subjectStateError, /custom development APIs/);
  await assert.rejects(client.request("/repos/example/widgets/pulls/42", undefined, "GET",
    { subjectType: "PullRequest", mergeQueue: true }), { code: "merge_queue_unavailable" });
  const standard = new GitHubClient({ run: async args => {
    assert.notEqual(args.at(-1), "graphql");
    return http(openPR);
  } });
  const oversized = { ...item(), number: "9007199254740993" };
  await standard.refreshSubjects([oversized]);
  assert.equal(standard.subjectSnapshot(oversized).subjectState, "open");
  assert.match(standard.subjectSnapshot(oversized).subjectStateError, /pull request number/);
  await assert.rejects(standard.request("/repos/example/widgets/issues/42", undefined, "GET",
    { subjectType: "PullRequest", mergeQueue: true }), { code: "merge_queue_unavailable" });
});
