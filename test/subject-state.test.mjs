import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, firstPage, RETRY_MS, SUBJECT_POLL_MS } from "../src/github.mjs";
import { apiTarget, InboxError, normalizeThreads } from "../src/model.mjs";
import { Inbox } from "../src/inbox.mjs";
import { startServer } from "../src/server.mjs";
import { http, staticSubjectTypes, thread } from "./fixtures.mjs";

function item(type = "PullRequest", baseUrl = "https://api.github.com") {
  return normalizeThreads([thread("1", { subject: {
    title: "Synthetic subject", type,
    url: `${baseUrl}/repos/example/widgets/${type === "Issue" ? "issues" : "pulls"}/42`,
  } })], apiTarget(baseUrl))[0];
}

test("subject lookups distinguish issue and PR states without retaining response content", async () => {
  for (const [type, body, expected] of [
    ["Issue", { state: "open" }, "open"],
    ["Issue", { state: "closed", state_reason: "completed" }, "closed"],
    ["Issue", { state: "closed", state_reason: null }, "closed"],
    ["Issue", { state: "closed", state_reason: "not_planned" }, "not_planned"],
    ["Issue", { state: "closed", state_reason: "duplicate" }, "duplicate"],
    ["Issue", { state: "open", state_reason: "not_planned" }, "open"],
    ["PullRequest", { state: "open", merged: false, draft: false }, "open"],
    ["PullRequest", { state: "open", merged: false, draft: true }, "draft"],
    ["PullRequest", { state: "closed", merged: false, draft: true }, "closed"],
    ["PullRequest", { state: "closed", merged: true, draft: false }, "merged"],
  ]) {
    const calls = [];
    const client = new GitHubClient({ now: () => 0, run: async args => {
      if (args.at(-1) === "graphql") return http({ data: { repository: { pullRequest: { isInMergeQueue: false } } } });
      calls.push(args);
      return http({ ...body, title: "Private upstream title", body: "Private upstream body", user: { login: "private-user" } });
    } });
    const subject = item(type);
    assert.deepEqual(client.subjectSnapshot(subject), { subjectState: null, subjectStateError: null });
    await client.refreshSubjects([subject, { ...subject, id: "2" }]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 7), ["api", "--hostname", "github.com", "--method", "GET", "--include", "-H"]);
    assert.equal(calls[0].at(-1), `/repos/example/widgets/${type === "Issue" ? "issues" : "pulls"}/42`);
    assert.deepEqual(client.subjectSnapshot(subject), {
      subjectState: expected, subjectStateError: null, subjectCheckedAt: 0, subjectStateStale: false,
    });
    assert.doesNotMatch(JSON.stringify([...client.subjectCache.values()]), /Private|private-user/);
    assert.equal(client.sequence, 0, "subject requests do not affect desktop notification response sequences");
    client.clear();
    assert.equal(client.subjectCache.size, 0);
  }
});

test("subject caching is shared, conditionally revalidated, and refreshes changed notifications", async () => {
  let now = 0;
  const calls = [];
  const client = new GitHubClient({ now: () => now, run: async args => {
    calls.push(args);
    return calls.length === 1 ? http({ state: "open" }, { etag: '"state"', "x-poll-interval": "600" }) :
      calls.length === 2 ? http(null, {}, 304) : http({ state: "closed" });
  } });
  const subject = item("Issue");
  await Promise.all([client.refreshSubjects([subject]), client.refreshSubjects([subject])]);
  assert.equal(calls.length, 1);
  now = SUBJECT_POLL_MS;
  await client.refreshSubjects([subject]);
  assert.equal(calls.length, 1);
  now = 600_000;
  await client.refreshSubjects([subject]);
  assert.ok(calls[1].includes('If-None-Match: "state"'));
  assert.equal(client.subjectSnapshot(subject).subjectState, "open");
  await client.refreshSubjects([{ ...subject, updatedAt: "2026-03-01T00:00:00.000Z" }]);
  assert.equal(calls.length, 3);
  assert.equal(client.subjectSnapshot(subject).subjectState, "closed");
  client.invalidateSubjects([subject]);
  await client.refreshSubjects([subject]);
  assert.equal(calls.length, 4);
});

test("Last-Modified and force revalidation apply to subjects, not the notification cache", async () => {
  let calls = 0;
  const modified = "Mon, 01 Jan 2024 00:00:00 GMT";
  const client = new GitHubClient({ now: () => 0, run: async args => {
    if (args.at(-1).startsWith("/notifications")) return http([thread()]);
    if (++calls === 1) return http({ state: "open" }, { "last-modified": modified });
    assert.ok(args.includes(`If-Modified-Since: ${modified}`));
    return http(null, {}, 304);
  } });
  await client.page(firstPage());
  const subject = item("Issue");
  await client.refreshSubjects([subject]);
  client.invalidateSubjects([subject]);
  await client.refreshSubjects([subject]);
  assert.equal(client.subjectSnapshot(subject).subjectState, "open");
  assert.equal(client.cache.size, 1);
});

test("older panels and duplicate subjects cannot roll back cache freshness or trigger repeated lookups", async () => {
  let calls = 0;
  const client = new GitHubClient({ now: () => 0, run: async () => {
    calls++;
    return http({ state: "open" });
  } });
  const older = item("Issue");
  const newer = { ...older, updatedAt: "2026-03-01T00:00:00.000Z" };
  await client.refreshSubjects([older, newer, older]);
  await client.refreshSubjects([older]);
  await client.refreshSubjects([newer]);
  assert.equal(calls, 1);
  assert.equal([...client.subjectCache.values()][0].updatedAt, newer.updatedAt);
});

test("pending status work excludes warm caches, unavailable links, and request backoff", async () => {
  let now = 0;
  const subject = item();
  const client = new GitHubClient({ now: () => now, run: async args => args.at(-1) === "graphql"
    ? http({ data: { repository: { pullRequest: { isInMergeQueue: false } } } })
    : http({ state: "open", merged: false, draft: false }) });
  assert.equal(client.subjectsNeedRefresh([]), false);
  assert.equal(client.subjectsNeedRefresh([{ ...subject, number: null }]), false);
  assert.equal(client.subjectsNeedRefresh([subject]), true);
  await client.refreshSubjects([subject]);
  assert.equal(client.subjectsNeedRefresh([subject]), false);
  client.mergeQueueCache.clear();
  assert.equal(client.subjectsNeedRefresh([subject]), true);
  await client.refreshSubjects([subject]);
  assert.equal(client.subjectsNeedRefresh([subject]), false);
  assert.equal(client.subjectsNeedRefresh([{ ...subject, updatedAt: "2026-03-01T00:00:00.000Z" }]), true);
  now = SUBJECT_POLL_MS;
  assert.equal(client.subjectsNeedRefresh([subject]), true);
  await client.refreshSubjects([subject]);
  assert.equal(client.subjectsNeedRefresh([subject]), false);
  client.invalidateSubjects([subject]);
  assert.equal(client.subjectsNeedRefresh([subject]), true);
  client.run = async () => http({}, {}, 404);
  await client.refreshSubjects([subject]);
  assert.equal(client.subjectsNeedRefresh([subject]), false);
  assert.equal(client.subjectsNeedRefresh([{ ...subject, updatedAt: "2026-03-01T00:00:00.000Z" }]), false);
  now += RETRY_MS;
  assert.equal(client.subjectsNeedRefresh([subject]), true);
  client.blockedUntil = now + RETRY_MS;
  assert.equal(client.subjectsNeedRefresh([subject]), false);
  now = client.blockedUntil;
  assert.equal(client.subjectsNeedRefresh([subject]), true);

  const custom = new GitHubClient({ apiBaseUrl: "https://api.example.test/rest/v3", run: async () =>
    http({ state: "open", merged: false, draft: false }) });
  const customSubject = item("PullRequest", custom.target.baseUrl);
  await custom.refreshSubjects([customSubject]);
  assert.equal(custom.subjectsNeedRefresh([customSubject]), false);
});

test("unsupported and unsafe subject links never produce API requests", async () => {
  const client = new GitHubClient({ run: async () => assert.fail("No subject request expected") });
  const unsupported = [...staticSubjectTypes, "FutureSubject", "__proto__", "constructor"]
    .map(type => ({ ...item(), type }));
  const invalid = [
    { ...item(), number: null }, { ...item(), number: "../1" }, { ...item(), number: "1?redirect=evil" },
    { ...item(), repository: "example/.." }, { ...item(), repository: "example/widgets/../../evil" },
    ...unsupported,
    ...normalizeThreads(["https://evil.test/repos/example/widgets/pulls/42",
      "https://api.github.com/repos/example/other/pulls/42",
      "https://api.github.com/repos/example/widgets/pulls/42?token=bad",
      "https://api.github.com/repos/example/widgets/pulls/42#bad",
    ].map(url => thread("1", { subject: { type: "PullRequest", title: "Synthetic", url } }))),
  ];
  await client.refreshSubjects(invalid);
  assert.match(client.subjectSnapshot(invalid[0]).subjectStateError, /supported link/);
  for (const subject of unsupported) assert.deepEqual(client.subjectSnapshot(subject), {});
});

test("custom API subjects remain pinned to the selected host and prefix", async () => {
  const baseUrl = "https://api.example.test/rest/v3";
  const client = new GitHubClient({ apiBaseUrl: baseUrl, run: async args => {
    assert.equal(args[2], "api.example.test");
    assert.equal(args.at(-1), `${baseUrl}/repos/example/widgets/pulls/42`);
    return http({ state: "closed", merged: true, draft: false });
  } });
  const subject = item("PullRequest", baseUrl);
  await client.refreshSubjects([subject]);
  assert.equal(client.subjectSnapshot(subject).subjectState, "merged");
});

test("missing access and malformed status keep the inbox usable and retry with backoff", async () => {
  for (const response of [
    http({}, {}, 403), http({}, {}, 404), http(null, {}, 304), http({ state: "closed" }),
    http(null), http([]), http({ state: "unexpected" }), http({ state: "open", merged: true, draft: false }),
    "HTTP/2 200 OK\r\n\r\nnot JSON",
    http({}, {}, 500),
  ]) {
    let now = 0;
    let calls = 0;
    const client = new GitHubClient({ now: () => now, run: async args => {
      if (args.at(-1).startsWith("/notifications")) return http([thread()]);
      calls++;
      return calls <= 2 ? response : http({ state: "closed", merged: true, draft: false });
    } });
    const subject = item();
    await client.refreshSubjects([subject]);
    assert.equal(client.subjectSnapshot(subject).subjectState, null);
    assert.ok(client.subjectSnapshot(subject).subjectStateError);
    assert.equal(client.blockedUntil, 0);
    assert.equal((await client.page(firstPage())).items.length, 1);
    client.invalidateSubjects([subject]);
    await client.refreshSubjects([subject]);
    assert.equal(calls, 1, "force refresh must not bypass a failed status lookup's backoff");
    now = RETRY_MS;
    await client.refreshSubjects([subject]);
    assert.equal(calls, 2);
    now += RETRY_MS;
    await client.refreshSubjects([subject]);
    assert.equal(calls, 2, "repeated failures increase backoff");
    now += RETRY_MS;
    await client.refreshSubjects([subject]);
    assert.equal(client.subjectSnapshot(subject).subjectState, "merged");
  }
});

test("subject rate limits and authentication failures pause other GitHub requests", async () => {
  for (const [status, headers, code] of [
    [429, { "retry-after": "700" }, "rate_limited"],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "800" }, "rate_limited"],
    [401, {}, "authentication"],
  ]) {
    let now = 0;
    let calls = 0;
    const client = new GitHubClient({ now: () => now, run: async () => {
      calls++;
      return http({}, headers, status);
    } });
    const subjects = [item(), { ...item(), number: "43" }];
    await client.refreshSubjects(subjects);
    assert.equal(calls, 1);
    assert.ok(client.blockedUntil >= RETRY_MS);
    await assert.rejects(client.page(firstPage(), undefined, { force: true }), { code });
    client.invalidateSubjects(subjects);
    await client.refreshSubjects(subjects);
    assert.equal(calls, 1);
    now = client.blockedUntil;
    client.run = async () => http({ state: "open", merged: false, draft: false });
    await client.refreshSubjects(subjects);
    assert.equal(client.subjectSnapshot(subjects[0]).subjectState, "open");
  }
});

test("subject error polling headers are honored and unexpected errors are not hidden", async () => {
  let now = 0;
  let calls = 0;
  const client = new GitHubClient({ now: () => now, run: async () => {
    calls++;
    return http({}, { "x-poll-interval": "900" }, 404);
  } });
  await client.refreshSubjects([item()]);
  now = RETRY_MS;
  await client.refreshSubjects([item()]);
  assert.equal(calls, 1);
  now = 900_000;
  client.run = async () => { throw new Error("Synthetic unexpected error"); };
  await assert.rejects(client.refreshSubjects([item()]), /Synthetic unexpected/);
});

test("notification writes do not interpret subject cache entries as notification pages", async () => {
  const client = new GitHubClient({ run: async args => args.includes("PATCH")
    ? "HTTP/2 205 Reset Content\r\n\r\n" : http({ state: "closed", merged: true, draft: false }) });
  await client.refreshSubjects([item()]);
  await client.markRead("1");
  assert.equal(client.subjectSnapshot(item()).subjectState, "merged");
});

test("subject lookups respect cancellation both before and during a request", async () => {
  for (const before of [true, false]) {
    const controller = new AbortController();
    const client = new GitHubClient({ run: async () => {
      controller.abort();
      return http({ state: "open" });
    } });
    if (before) controller.abort();
    await assert.rejects(client.refreshSubjects([item("Issue")], controller.signal), { code: "closed" });
    assert.equal(client.subjectCache.size, 0);
    assert.equal(client.blockedUntil, 0);
  }
});

test("protected snapshots hydrate in the background without delaying the inbox or leaking to agents", async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const calls = [];
  const client = new GitHubClient({ run: async (args, { signal }) => {
    calls.push(args.at(-1));
    if (args.at(-1).startsWith("/notifications")) return http([thread()]);
    assert.equal(signal.aborted, false);
    await held;
    return http({ state: "closed", merged: true, draft: false });
  } });
  const inbox = new Inbox(client);
  const server = await startServer(inbox, { development: null });
  t.after(async () => { release(); await server.close(); });
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  assert.equal((await fetch(`${url.origin}/api/state`)).status, 403);
  assert.equal(calls.length, 0);
  const response = await fetch(`${url.origin}/api/refresh`, { method: "POST", headers, body: "{}" });
  const snapshot = await response.json();
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.subjectsLoading, true);
  assert.equal(snapshot.loaded, 1);
  assert.equal(snapshot.groups[0].items[0].subjectState, null);
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /subjectState|merged|example\/|Synthetic/);
  release();
  await client.queue;
  const populated = await (await fetch(`${url.origin}/api/state`, { headers })).json();
  assert.equal(populated.groups[0].items[0].subjectState, "merged");
  assert.equal(populated.subjectsLoading, false);
  assert.equal(calls.filter(path => path.startsWith("/repos/")).length, 1);
});

test("closing the panel cancels background subject work and unexpected failures are sanitized", async t => {
  for (const unexpected of [false, true]) {
    let now = 0;
    const logs = [];
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const client = new GitHubClient({ now: () => now, run: async (args, { signal }) => {
      if (args.at(-1).startsWith("/notifications")) return http([thread()]);
      started();
      if (unexpected) throw new Error("Private upstream detail");
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      throw new InboxError("closed", "The canvas was closed.", 410);
    } });
    const inbox = new Inbox(client);
    await inbox.refresh();
    const server = await startServer(inbox, { development: null, log: message => logs.push(message) });
    t.after(() => server.close());
    const url = new URL(server.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
    await fetch(`${url.origin}/api/state`, { headers });
    await entered;
    if (unexpected) {
      const result = await (await fetch(`${url.origin}/api/state`, { headers })).json();
      assert.match(result.groups[0].items[0].subjectStateError, /Inspect the extension log/);
      assert.equal(result.subjectsLoading, false);
      assert.equal(logs.length, 1, "local polling must not keep retrying an unexpected failure");
      assert.doesNotMatch(JSON.stringify(logs), /Private/);
      now += RETRY_MS;
      await fetch(`${url.origin}/api/state`, { headers });
      assert.equal(logs.length, 2);
    }
    await server.close();
    assert.equal(client.subjectCache.size, 0);
    if (!unexpected) assert.deepEqual(logs, []);
  }
});

test("unexpected hydration failures preserve cached API states and reported workflow results", async t => {
  let now = 1000;
  let failing = false;
  const logs = [];
  const raw = [thread(), thread("2", { subject: {
    type: "Issue", title: "Synthetic failing lookup", url: "https://api.github.com/repos/example/widgets/issues/43",
  } }), thread("3", { subject: { type: "CheckSuite", title: "Synthetic build workflow run failed for main", url: null } })];
  const items = normalizeThreads(raw);
  const client = new GitHubClient({ now: () => now, run: async args => {
    if (args.at(-1).startsWith("/notifications")) return http(raw);
    if (failing) throw new Error("Private upstream detail");
    return http(args.at(-1).endsWith("/pulls/42")
      ? { state: "closed", merged: true, draft: false } : { state: "closed" });
  } });
  await client.refreshSubjects([items[0]]);
  const inbox = new Inbox(client);
  await inbox.refresh();
  const server = await startServer(inbox, { development: null, log: message => logs.push(message) });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const snapshot = async () => (await fetch(`${url.origin}/api/state`, { headers })).json();
  failing = true;
  await snapshot();
  await client.queue;
  const failed = await snapshot();
  const [cached, unknown, reported] = failed.groups[0].items;
  assert.equal(cached.subjectState, "merged");
  assert.equal(cached.subjectCheckedAt, 1000);
  assert.equal(cached.subjectStateStale, true);
  assert.equal(unknown.subjectState, null);
  assert.equal(reported.subjectState, "failure");
  assert.equal(reported.subjectStateSource, "notification");
  assert.equal(reported.subjectCheckedAt, undefined);
  assert.equal(reported.subjectStateStale, undefined);
  for (const row of [cached, unknown, reported]) assert.match(row.subjectStateError, /Inspect the extension log/);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /Private/);
  failing = false;
  now += RETRY_MS;
  await snapshot();
  await client.queue;
  const recovered = await snapshot();
  assert.equal(recovered.groups[0].items[0].subjectState, "merged");
  assert.equal(recovered.groups[0].items[0].subjectStateStale, false);
  assert.equal(recovered.groups[0].items[0].subjectCheckedAt, 1000);
  assert.equal(recovered.groups[0].items[2].subjectStateError, null);
});
