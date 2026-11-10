import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, firstPage, RETRY_MS, SUBJECT_POLL_MS } from "../src/provider/github.mjs";
import { apiTarget, InboxError, normalizeThreads } from "../src/shared/model.mjs";
import { Inbox } from "../src/provider/inbox.mjs";
import { startServer } from "../src/provider/server.mjs";
import { http, thread } from "./fixtures.mjs";

const response = (discussion, headers) => http({ data: { repository: { discussion } } }, headers);
const resolved = { closed: true, isAnswered: false, stateReason: "RESOLVED" };
const raw = (url = "https://api.github.com/repos/example/widgets/discussions/74") =>
  thread("1", { subject: { type: "Discussion", title: "Synthetic discussion", url } });
const item = (baseUrl = "https://api.github.com") =>
  normalizeThreads([raw(`${baseUrl}/repos/example/widgets/discussions/74`)], apiTarget(baseUrl))[0];

test("discussion icons use read-only GraphQL state without fetching or retaining discussion content", async () => {
  for (const [state, expected] of [
    [{ closed: false, isAnswered: false, stateReason: null }, "open"],
    [{ closed: false, isAnswered: null, stateReason: "REOPENED" }, "open"],
    [{ closed: false, isAnswered: true, stateReason: null }, "answered"],
    [resolved, "closed"],
    [{ ...resolved, isAnswered: true }, "closed"],
    [{ ...resolved, stateReason: null }, "closed"],
    [{ ...resolved, stateReason: "DUPLICATE" }, "duplicate"],
    [{ ...resolved, stateReason: "OUTDATED" }, "outdated"],
  ]) {
    const calls = [];
    const client = new GitHubClient({ now: () => 0, run: async args => {
      calls.push(args);
      return response({ ...state, title: "Private upstream title", body: "Private upstream body" });
    } });
    const subject = item();
    assert.equal(subject.discussionNumber, "74");
    assert.equal(subject.number, null, "State lookup must not change existing row metadata or titles");
    assert.equal(client.subjectsNeedRefresh([subject]), true);
    await client.refreshSubjects([subject]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 7), ["api", "--hostname", "github.com", "--method", "POST", "--include", "-H"]);
    assert.equal(calls[0].at(-1), "graphql");
    for (const field of ["owner=example", "name=widgets", "number=74"]) assert.ok(calls[0].includes(field));
    const query = calls[0].find(arg => arg.startsWith("query="));
    assert.match(query, /^query=query\(\$owner:String!,\$name:String!,\$number:Int!\)/);
    assert.match(query, /discussion\(number:\$number\)\{closed isAnswered stateReason viewerDidAuthor\}/);
    assert.doesNotMatch(query, /mutation|body|title|comments|author/);
    assert.deepEqual(client.subjectSnapshot(subject), {
      subjectState: expected, subjectStateError: null, subjectCheckedAt: 0, subjectStateStale: false,
    });
    assert.equal(client.subjectsNeedRefresh([subject]), false);
    assert.equal(client.subjectLinkPending(subject), false);
    assert.doesNotMatch(JSON.stringify([...client.subjectCache.values()]), /Private/);
    assert.equal(client.sequence, 0);
  }
});

test("discussion lookups share the cache and revalidate on expiry, force refresh or a changed notification", async () => {
  let now = 0;
  const calls = [];
  const client = new GitHubClient({ now: () => now, run: async args => {
    calls.push(args);
    return response(resolved, { etag: '"ignored"', "x-poll-interval": "600" });
  } });
  const subject = item();
  await Promise.all([client.refreshSubjects([subject]), client.refreshSubjects([subject])]);
  assert.equal(calls.length, 1);
  now = SUBJECT_POLL_MS;
  await client.refreshSubjects([subject]);
  assert.equal(calls.length, 1);
  now = 600_000;
  await client.refreshSubjects([subject]);
  assert.equal(calls.length, 2);
  client.invalidateSubjects([subject]);
  await client.refreshSubjects([subject]);
  assert.equal(calls.length, 3);
  const newer = { ...subject, updatedAt: "2026-03-01T00:00:00.000Z" };
  await client.refreshSubjects([newer, subject]);
  await client.refreshSubjects([subject]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(args => !args.some(arg => arg.startsWith("If-None-Match:"))));
  client.clear();
  assert.equal(client.subjectCache.size, 0);
});

test("invalid or inaccessible discussion states preserve cached icons and sanitize errors", async () => {
  for (const invalid of [
    response(null), response({}), response({ ...resolved, closed: "true" }),
    response({ ...resolved, isAnswered: undefined }), response({ ...resolved, stateReason: "UNKNOWN" }),
    response({ ...resolved, stateReason: "REOPENED" }), response({ ...resolved, closed: false }),
    http({ errors: [{ message: "Private access error" }], data: { repository: { discussion: resolved } } }),
    http({}, {}, 403), http({}, {}, 404), http(null, {}, 304), "HTTP/2 200 OK\r\n\r\nnot JSON",
  ]) {
    let now = 1000;
    let calls = 0;
    const client = new GitHubClient({ now: () => now, run: async () => ++calls === 1 ? response(resolved) : invalid });
    const subject = item();
    await client.refreshSubjects([subject]);
    client.invalidateSubjects([subject]);
    await client.refreshSubjects([subject]);
    const state = client.subjectSnapshot(subject);
    assert.equal(state.subjectState, "closed");
    assert.equal(state.subjectStateStale, true);
    assert.equal(state.subjectCheckedAt, 1000);
    assert.ok(state.subjectStateError);
    assert.doesNotMatch(state.subjectStateError, /Private/);
    assert.equal(client.blockedUntil, 0);
    client.invalidateSubjects([subject]);
    await client.refreshSubjects([subject]);
    assert.equal(calls, 2);
    now += RETRY_MS;
    await client.refreshSubjects([subject]);
    assert.equal(calls, 3);
  }
});

test("discussion GraphQL primary limits pause discussion and merge queue checks without blocking REST", async () => {
  for (const limited of [
    http({ errors: [{ type: "RATE_LIMITED", message: "Private quota detail" }] }),
    http({}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "900" }, 403),
    response(resolved, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "900" }),
  ]) {
    let now = 0;
    let graphCalls = 0;
    const client = new GitHubClient({ now: () => now, run: async args => {
      if (args.at(-1) === "graphql") { graphCalls++; return limited; }
      if (args.includes("PATCH")) return "HTTP/2 205 Synthetic\r\n\r\n";
      if (args.at(-1).startsWith("/notifications?")) return http([raw()]);
      return http({ state: "open", merged: false, draft: false });
    } });
    const subject = item();
    await client.refreshSubjects([subject]);
    assert.ok(client.graphqlBlockedUntil >= RETRY_MS);
    assert.equal(client.blockedUntil, 0);
    assert.equal(client.serverBlockedUntil, 0);
    assert.equal(client.subjectsNeedRefresh([subject]), false);
    assert.match(client.subjectSnapshot(subject).subjectStateError, /GraphQL rate limit/);
    const pr = normalizeThreads([thread()])[0];
    await client.refreshSubjects([pr]);
    assert.equal(client.subjectSnapshot(pr).subjectState, "open");
    assert.equal(graphCalls, 1);
    assert.equal((await client.page(firstPage())).items.length, 1);
    await client.markRead("1");
    now = client.graphqlBlockedUntil;
    client.run = async () => response(resolved);
    await client.refreshSubjects([subject]);
    assert.equal(client.subjectSnapshot(subject).subjectState, "closed");
    assert.equal(client.subjectSnapshot(subject).subjectStateError, null);
  }
});

test("discussion authentication and secondary rate limits pause shared requests", async () => {
  for (const [limited, code] of [
    [http({}, {}, 401), "authentication"],
    [http({}, { "retry-after": "600" }, 429), "rate_limited"],
    [http({ message: "Secondary rate limit" }, { "x-ratelimit-remaining": "0" }, 403), "rate_limited"],
    [http({ errors: [{ type: "RATE_LIMITED", message: "Secondary rate limit" }] }), "rate_limited"],
    [http({ errors: [{ type: "RATE_LIMITED" }] }, { "retry-after": "600" }), "rate_limited"],
  ]) {
    const client = new GitHubClient({ now: () => 0, run: async () => limited });
    await client.refreshSubjects([item()]);
    assert.ok(client.blockedUntil >= RETRY_MS);
    await assert.rejects(client.page(firstPage(), undefined, { force: true }), { code });
  }
});

test("mixed refreshes preserve cached discussion state and lifetime while GraphQL is paused", async () => {
  let calls = 0;
  const client = new GitHubClient({ now: () => 1000, run: async args => {
    calls++;
    return args.at(-1) === "graphql" ? response(resolved, { "x-poll-interval": "900" }) : http({ state: "closed" });
  } });
  const discussion = item();
  const issue = normalizeThreads([thread("2", {
    subject: { type: "Issue", title: "Synthetic issue", url: "https://api.github.com/repos/example/widgets/issues/1" },
  })])[0];
  await client.refreshSubjects([discussion]);
  const cached = client.subjectCache.get("/repos/example/widgets/discussions/74");
  client.graphqlBlockedUntil = 301_000;
  client.graphqlLastError = new InboxError("graphql_rate_limited", "GraphQL checks paused.", 429);
  await client.refreshSubjects([discussion, issue]);
  assert.equal(calls, 2);
  assert.equal(client.subjectCache.get("/repos/example/widgets/discussions/74"), cached);
  assert.equal(cached.nextRefreshAt, 901_000);
  const snapshot = client.subjectSnapshot(discussion);
  assert.equal(snapshot.subjectState, "closed");
  assert.equal(snapshot.subjectStateStale, false);
  assert.equal(snapshot.subjectCheckedAt, 1000);
  assert.match(snapshot.subjectStateError, /paused/);
});

test("a GraphQL pause learned during request preparation does not overwrite cached discussions", async () => {
  let calls = 0;
  const client = new GitHubClient({ now: () => 1000, run: async () => {
    calls++;
    return response(resolved, { "x-poll-interval": "900" });
  } });
  const discussion = item();
  await client.refreshSubjects([discussion]);
  const cached = client.subjectCache.get("/repos/example/widgets/discussions/74");
  client.beforeRequest = async () => { client.graphqlBlockedUntil = 301_000; };
  await client.refreshSubjects([discussion]);
  assert.equal(calls, 1);
  assert.equal(client.subjectCache.get("/repos/example/widgets/discussions/74"), cached);
  assert.equal(client.subjectSnapshot(discussion).subjectStateStale, false);
});

test("discussion requests never escape validated links, GraphQL integer bounds or custom APIs", async () => {
  const client = new GitHubClient({ run: async () => assert.fail("No request expected") });
  const invalid = normalizeThreads([
    null, "https://evil.test/repos/example/widgets/discussions/74",
    "https://api.github.com/repos/example/other/discussions/74",
    "https://api.github.com/repos/example/widgets/discussions/74?token=bad",
    "https://api.github.com/repos/example/widgets/discussions/74#bad",
  ].map(url => raw(url)));
  invalid.push({ ...item(), discussionNumber: "../74" }, { ...item(), repository: "example/.." },
    { ...item(), discussionNumber: "2147483648" });
  await client.refreshSubjects(invalid);
  assert.ok(invalid.every(subject => client.subjectSnapshot(subject).subjectStateError));
  const custom = new GitHubClient({ apiBaseUrl: "https://api.example.test/rest/v3",
    run: async () => assert.fail("Custom REST APIs must never query github.com discussions") });
  const subject = item(custom.target.baseUrl);
  assert.equal(custom.subjectsNeedRefresh([subject]), false);
  await custom.refreshSubjects([subject]);
  assert.match(custom.subjectSnapshot(subject).subjectStateError, /custom development APIs/);
});

test("closing a panel cancels discussion lookups without caching a response", async () => {
  const controller = new AbortController();
  const client = new GitHubClient({ run: async () => {
    controller.abort();
    return response(resolved);
  } });
  await assert.rejects(client.refreshSubjects([item()], controller.signal), { code: "closed" });
  assert.equal(client.subjectCache.size, 0);
  assert.equal(client.blockedUntil, 0);
});

test("discussion state is only exposed in protected snapshots, not agent summaries", async t => {
  const client = new GitHubClient({ run: async args =>
    args.at(-1) === "graphql" ? response(resolved) : http([raw()]) });
  const inbox = new Inbox(client);
  await inbox.refresh();
  await client.refreshSubjects(inbox.loadedItems());
  const server = await startServer(inbox);
  t.after(() => server.close());
  const url = new URL(server.url);
  assert.equal((await fetch(new URL("/api/state", url))).status, 403);
  const result = await fetch(new URL("/api/state", url), {
    headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
  });
  const state = await result.json();
  assert.equal(state.groups[0].items[0].subjectState, "closed");
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /discussionNumber|subjectState|Synthetic|example\//);
});
