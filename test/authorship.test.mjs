import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, RETRY_MS, SUBJECT_POLL_MS } from "../src/provider/github.mjs";
import { Inbox } from "../src/provider/inbox.mjs";
import { apiTarget, attentionCounts, groupThreads, normalizeThreads } from "../src/shared/model.mjs";
import { startServer } from "../src/provider/server.mjs";
import { http, inboxNext, retrySelection, thread } from "./fixtures.mjs";

function row(id, type = "Issue", overrides = {}, baseUrl = "https://api.github.com") {
  const resource = { Issue: "issues", PullRequest: "pulls", Discussion: "discussions" }[type];
  return thread(id, {
    reason: "mention",
    subject: { type, title: `Synthetic authored item ${id}`, url: `${baseUrl}/repos/example/widgets/${resource}/${id}` },
    ...overrides,
  });
}

const details = (id = 100) => ({ state: "open", merged: false, draft: true, user: { id, login: "private-author" } });
const discussion = mine => ({ data: { repository: { discussion: {
  closed: false, isAnswered: false, stateReason: null, viewerDidAuthor: mine,
} } } });

test("authorship reuses REST details, compares IDs, and resolves discussions without retaining identities in snapshots", async t => {
  const rows = [row("1"), row("2", "PullRequest"), row("3", "Discussion"), row("4", "Discussion"),
    row("5", "Issue", { reason: "author" })];
  const calls = [];
  const client = new GitHubClient({ now: () => 0, run: async args => {
    calls.push(args);
    if (args.at(-1) === "/user") return http({ id: 100, login: "private-viewer" });
    if (args.at(-1) === "graphql") return http(discussion(args.includes("number=3")));
    return http(details(args.at(-1).endsWith("/5") ? 200 : "100"));
  } });
  const inbox = new Inbox(client);
  t.after(() => inbox.close());
  const items = normalizeThreads(rows);
  inbox.pages = [{ items, sequence: 1 }];
  assert.deepEqual(client.authorshipSnapshot(items[0]), { mine: null, authorshipError: null });
  await client.refreshSubjects(items.slice(0, 1));
  assert.equal(client.authorshipSnapshot(items[0]).mine, null, "A REST author alone cannot identify the viewer");
  await Promise.all([client.refreshAuthorship(items), client.refreshAuthorship(items)]);
  assert.equal(calls.filter(args => args.at(-1) === "/user").length, 1);
  assert.equal(calls.filter(args => args.at(-1).endsWith("/issues/1")).length, 1);
  assert.equal(calls.length, 6, "One viewer lookup and one existing detail request per subject, without merge queue checks");
  assert.deepEqual(items.map(item => client.authorshipSnapshot(item).mine), [true, true, true, false, false]);
  assert.equal(client.authorshipNeedsRefresh(items), false);
  assert.equal(inbox.snapshot().attentionCounts.mine, 3);
  assert.deepEqual(inbox.snapshot().authorship, { pending: 0, unavailable: 0 });
  assert.doesNotMatch(JSON.stringify(inbox.snapshot()), /authorId|private-author|private-viewer/);
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /Synthetic|example\/|authorId|viewerDidAuthor/);
  assert.doesNotMatch(JSON.stringify([...client.subjectCache.values()]), /private-author|private-viewer/);
  assert.equal(client.sequence, 0, "Authorship does not affect desktop baselines");
  assert.deepEqual(client.authorshipSnapshot({ ...items[0], type: "Release" }), {});
});

test("background authorship scans cached loaded selections linearly", async () => {
  const measurements = [];
  for (const size of [100, 400]) {
    let typeReads = 0;
    let loadedSnapshots = 0;
    let requests = 0;
    const client = new GitHubClient({ now: () => 0, run: async args => {
      requests++;
      return http(args.at(-1) === "/user" ? { id: 100 } : details());
    } });
    const inbox = new Inbox(client);
    const items = normalizeThreads(Array.from({ length: size }, (_, index) => row(String(index + 1))))
      .map(item => ({ ...item, get type() { typeReads++; return item.type; } }));
    inbox.pages = [{ items, sequence: 1 }];
    await client.refreshSubjects(items);
    const loadedItems = inbox.loadedItems.bind(inbox);
    inbox.loadedItems = () => { loadedSnapshots++; return loadedItems(); };
    const refreshAuthorship = client.refreshAuthorship.bind(client);
    let loading;
    client.refreshAuthorship = (...args) => loading = refreshAuthorship(...args);
    const server = await startServer(inbox, { development: false });
    try {
      const url = new URL(server.url);
      typeReads = 0;
      const response = await fetch(`${url.origin}/api/state`, {
        headers: { Authorization: `Bearer ${url.hash.slice(1)}`, "X-Notification-Subjects": "manual" },
      });
      assert.equal(response.status, 200);
      await response.json();
      assert.ok(loading);
      await loading;
      measurements.push(typeReads);
      assert.ok(loadedSnapshots <= 6, "Per-item scheduling must not rebuild the loaded inbox");
      assert.equal(requests, size + 1, "The warm authorship pass needs only the viewer request");
      assert.equal(inbox.snapshot().attentionCounts.mine, size);
    } finally {
      await server.close();
    }
  }
  assert.ok(measurements[1] <= measurements[0] * 5,
    `Quadrupling the inbox must not cause quadratic selection scans: ${measurements.join(", ")}`);
});

test("cached authorship selections follow pagination and triage while requests are in flight", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => row(String(index + 1)));
  const requested = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const client = new GitHubClient({ run: async args => {
    const endpoint = args.at(-1);
    if (endpoint.startsWith("/notifications?")) return endpoint.includes("page=2")
      ? http([row("51"), row("52")]) : http(rows, { link: inboxNext });
    if (endpoint === "/user") return http({ id: 100 });
    requested.push(endpoint);
    if (requested.length === 20) entered();
    if (requested.length <= 20) await held;
    return http(details());
  } });
  const inbox = new Inbox(client, { mode: "unread" });
  await inbox.refresh();
  const refreshAuthorship = client.refreshAuthorship.bind(client);
  let loading;
  client.refreshAuthorship = (...args) => loading = refreshAuthorship(...args);
  const server = await startServer(inbox, { development: false });
  try {
    const url = new URL(server.url);
    const response = await fetch(`${url.origin}/api/state`, {
      headers: { Authorization: `Bearer ${url.hash.slice(1)}`, "X-Notification-Subjects": "manual" },
    });
    assert.equal(response.status, 200);
    await response.json();
    await started;
    await inbox.more();
    await inbox.setFilters({ query: "no matches", attention: "mentioned" });
    inbox.onThreadUpdated("21", "read");
    inbox.onThreadUpdated("22", "done");
    release();
    await loading;
    const expected = [...rows.map(item => item.id), "51", "52"].filter(id => id !== "22")
      .map(id => `/repos/example/widgets/issues/${id}`);
    assert.deepEqual(requested, expected);
    assert.equal(inbox.snapshot().attentionCounts.mine, 50);
    assert.equal(inbox.snapshot().matching, 0, "Display filters do not narrow authorship resolution");
  } finally {
    release();
    await server.close();
  }
});

test("Mine matches confirmed authorship rather than notification reasons, preserving read rows, search and API order", () => {
  const items = normalizeThreads([
    row("1", "Issue", { unread: false }), row("2", "PullRequest", { reason: "author" }),
    row("3", "Discussion", { reason: "subscribed" }), row("4"), row("5"),
  ]).map((item, index) => ({ ...item, mine: [true, false, true, null, true][index] }));
  const unsupported = { ...items[0], id: "6", type: "CheckSuite", mine: true };
  assert.equal(attentionCounts([...items, unsupported, items[0]]).mine, 3);
  assert.deepEqual(groupThreads([...items, unsupported], { query: "", attention: "mine" })[0].items.map(item => item.id),
    ["1", "3", "5"]);
  const searched = groupThreads(items, { query: "item 1", attention: "mine" });
  assert.equal(searched[0].unread, 0);
  assert.deepEqual(searched[0].items.map(item => item.id), ["1"]);
  assert.equal(attentionCounts(items).mine, 3, "Tab counts ignore search");
});

test("authorship preserves conditional responses, revalidates the viewer, and respects error backoff", async () => {
  let now = 0;
  let viewerId = 100;
  let failure = false;
  const calls = [];
  const client = new GitHubClient({ now: () => now, run: async args => {
    calls.push(args);
    if (args.at(-1) === "/user") return failure ? http({}, {}, 403) : http({ id: viewerId });
    return args.includes('If-None-Match: "author"') ? http(null, {}, 304) : http(details(), { etag: '"author"' });
  } });
  const items = normalizeThreads([row("1")]);
  await client.refreshAuthorship(items);
  assert.equal(client.authorshipSnapshot(items[0]).mine, true);
  await client.refreshAuthorship(items);
  assert.equal(calls.length, 2);
  now = SUBJECT_POLL_MS;
  viewerId = 200;
  assert.equal(client.authorshipNeedsRefresh(items), true);
  await client.refreshAuthorship(items);
  assert.equal(client.authorshipSnapshot(items[0]).mine, false, "Compare with the current cached viewer, not a stored boolean");
  failure = true;
  client.invalidateSubjects(items);
  await client.refreshAuthorship(items);
  assert.equal(client.authorshipSnapshot(items[0]).mine, null);
  assert.match(client.authorshipSnapshot(items[0]).authorshipError, /access/);
  const before = calls.length;
  client.invalidateSubjects(items);
  await client.refreshAuthorship(items);
  assert.equal(calls.filter(args => args.at(-1) === "/user").length, 3, "Force refresh does not bypass viewer backoff");
  assert.ok(calls.length <= before + 1, "Only the healthy subject may revalidate");
  now += RETRY_MS;
  failure = false;
  viewerId = 100;
  await client.refreshAuthorship(items);
  assert.equal(client.authorshipSnapshot(items[0]).mine, true);
  client.clear();
  assert.equal(client.authorshipSnapshot(items[0]).mine, null);
});

test("missing and malformed author data stays unknown without hiding a valid status", async () => {
  for (const author of [null, {}, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: "100x" }, { id: Number.MAX_SAFE_INTEGER + 1 }]) {
    const client = new GitHubClient({ run: async args => http(args.at(-1) === "/user" ? { id: 100 } : { ...details(), user: author }) });
    const items = normalizeThreads([row("1")]);
    await client.refreshAuthorship(items);
    assert.equal(client.subjectSnapshot(items[0]).subjectState, "open");
    assert.equal(client.authorshipSnapshot(items[0]).mine, null);
    assert.match(client.authorshipSnapshot(items[0]).authorshipError, /author ID/);
  }
  for (const response of [http({ id: null }), http(discussion(undefined))]) {
    const isDiscussion = response.includes("repository");
    const client = new GitHubClient({ run: async args => args.at(-1) === "/user" || isDiscussion ? response : http(details()) });
    const items = normalizeThreads([row("1", isDiscussion ? "Discussion" : "Issue")]);
    await client.refreshAuthorship(items);
    assert.equal(client.authorshipSnapshot(items[0]).mine, null);
    assert.ok(client.authorshipSnapshot(items[0]).authorshipError);
  }
});

test("force refresh during a viewer lookup retains the pending invalidation", async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let viewerCalls = 0;
  const client = new GitHubClient({ now: () => 1000, run: async args => {
    if (args.at(-1) !== "/user") return http(details());
    if (++viewerCalls === 1) { entered(); await held; }
    return http({ id: viewerCalls === 1 ? 100 : 200 });
  } });
  const items = normalizeThreads([row("1")]);
  const loading = client.refreshAuthorship(items);
  try {
    await started;
    client.invalidateSubjects(items);
  } finally {
    release();
  }
  await loading;
  assert.equal(client.authorshipNeedsRefresh(items), true);
  await client.refreshAuthorship(items);
  assert.equal(viewerCalls, 2);
  assert.equal(client.authorshipSnapshot(items[0]).mine, false);
});

test("Mine read/done batches and retries never add newly confirmed authorship", async t => {
  for (const scope of ["repository", "date", "shown"]) {
    for (const action of ["read", "done"]) {
      await t.test(`${scope} ${action}`, async subtest => {
        let now = 0;
        let first = true;
        let anotherMine = false;
        const writes = [];
        const client = new GitHubClient({ now: () => now, run: async args => {
          const endpoint = args.at(-1);
          if (args.includes("PATCH") || args.includes("DELETE")) {
            writes.push(endpoint);
            if (first) { first = false; return http({}, {}, 500); }
            return http(null, {}, args.includes("PATCH") ? 205 : 204);
          }
          if (endpoint === "/user") return http({ id: 100 });
          return http(details(endpoint.endsWith("/3") && !anotherMine ? 200 : 100));
        } });
        const inbox = new Inbox(client, { attention: "mine" });
        subtest.after(() => inbox.close());
        inbox.pages = [{ sequence: 1, items: normalizeThreads([row("1"), row("2", "Issue", { unread: false }), row("3")]) }];
        await client.refreshAuthorship(inbox.loadedItems());
        const selection = scope === "repository" ? { repository: "example/widgets", selectionKey: inbox.groups()[0].selectionKey } :
          { scope, selectionKey: inbox.shownSelection().selectionKey, ...(scope === "date" ? { date: "2026-01-10", timeZone: "UTC" } : {}) };
        inbox.batch.start({ ...selection, action });
        await inbox.batch.done;
        const token = inbox.batch.snapshot().token;
        now = client.blockedUntil;
        anotherMine = true;
        client.invalidateSubjects(inbox.loadedItems());
        await client.refreshAuthorship(inbox.loadedItems());
        assert.ok(inbox.groups()[0].items.some(item => item.id === "3"), "A new confirmed match is visible before retry");
        inbox.batch.retry(retrySelection(inbox, { token }));
        await inbox.batch.done;
        assert.deepEqual([...writes].sort(), action === "done"
          ? ["/notifications/threads/1", "/notifications/threads/1", "/notifications/threads/2"]
          : ["/notifications/threads/1", "/notifications/threads/1"]);
      });
    }
  }
});

test("authorship shares primary/secondary limits, cancellation and safe custom API boundaries", async () => {
  for (const response of [
    http({}, { "retry-after": "600" }, 429),
    http({}, {}, 401),
  ]) {
    const client = new GitHubClient({ now: () => 0, run: async () => response });
    const items = normalizeThreads([row("1")]);
    await client.refreshAuthorship(items);
    assert.ok(client.blockedUntil >= RETRY_MS);
    assert.equal(client.authorshipNeedsRefresh(items), false);
    assert.equal(client.authorshipSnapshot(items[0]).mine, null);
    assert.ok(client.authorshipSnapshot(items[0]).authorshipError);
  }
  const client = new GitHubClient({ now: () => 0, run: async () => http({ errors: [{ type: "RATE_LIMITED" }] }) });
  const discussions = normalizeThreads([row("1", "Discussion"), row("2", "Discussion")]);
  await client.refreshAuthorship(discussions.slice(0, 1));
  assert.equal(client.blockedUntil, 0);
  assert.equal(client.authorshipNeedsRefresh(discussions), false);
  assert.match(client.authorshipSnapshot(discussions[1]).authorshipError, /GraphQL rate limit/);

  const baseUrl = "https://api.example.test/rest/v3";
  const calls = [];
  const custom = new GitHubClient({ apiBaseUrl: baseUrl, run: async args => {
    calls.push(args);
    assert.equal(args[2], "api.example.test");
    return http(args.at(-1) === `${baseUrl}/user` ? { id: 100 } : details());
  } });
  const items = normalizeThreads([row("1", "Issue", {}, baseUrl), row("2", "Discussion", {}, baseUrl)], apiTarget(baseUrl));
  await custom.refreshAuthorship(items);
  assert.deepEqual(calls.map(args => args.at(-1)), [`${baseUrl}/user`, `${baseUrl}/repos/example/widgets/issues/1`]);
  assert.equal(custom.authorshipSnapshot(items[0]).mine, true);
  assert.match(custom.authorshipSnapshot(items[1]).authorshipError, /custom development APIs/);
  const invalid = { ...items[0], number: "../1" };
  await custom.refreshAuthorship([invalid]);
  assert.equal(calls.length, 2);
  assert.match(custom.authorshipSnapshot(invalid).authorshipError, /supported link/);
  const controller = new AbortController();
  custom.run = async () => { controller.abort(); return http({ id: 100 }); };
  custom.invalidateSubjects(items);
  await assert.rejects(custom.refreshAuthorship(items, controller.signal), { code: "closed" });
});

test("Mine resolves filtered and unexpanded loaded rows, expands only with pagination, and binds bulk writes to its snapshot", async t => {
  const rows = [row("1"), row("2", "PullRequest", { reason: "subscribed", unread: false }), row("3", "Discussion")];
  const calls = [];
  const writes = [];
  const client = new GitHubClient({ run: async args => {
    const endpoint = args.at(-1);
    calls.push(endpoint);
    if (args.includes("DELETE")) { writes.push(endpoint); return http(null, {}, 204); }
    if (endpoint.startsWith("/notifications?")) return endpoint.includes("page=2")
      ? http([row("4")]) : http(rows, { link: inboxNext });
    if (endpoint === "/user") return http({ id: 100 });
    if (endpoint === "graphql") return http(discussion(false));
    return http(details());
  } });
  const inbox = new Inbox(client, { attention: "mine", query: "item 2" });
  const server = await startServer(inbox);
  t.after(() => server.close());
  const url = new URL(server.url);
  const call = async (path, body) => {
    const response = await fetch(`${url.origin}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json",
        "X-Notification-Subjects": "manual" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const settled = async () => {
    for (let count = 0; count < 100; count++) {
      const state = await call("state");
      if (!state.subjectsLoading) return state;
    }
    assert.fail("Authorship did not settle");
  };
  await call("refresh", {});
  const state = await settled();
  assert.equal(state.attentionCounts.mine, 2);
  assert.equal(state.matching, 1);
  assert.deepEqual(state.groups[0].items.map(item => item.id), ["2"]);
  assert.equal(state.groups[0].items[0].unread, false);
  assert.equal(calls.some(path => path.includes("page=2")), false);
  assert.equal(calls.filter(path => path === "graphql").length, 1, "Only discussions, not hidden PR merge queues");
  await call("filters", { query: "" });
  const old = inbox.shownSelection();
  await call("more", {});
  assert.equal((await settled()).attentionCounts.mine, 3);
  assert.throws(() => inbox.batch.start({ scope: "shown", selectionKey: old.selectionKey, action: "done" }), { code: "selection_changed" });
  inbox.batch.start({ scope: "shown", selectionKey: inbox.shownSelection().selectionKey, action: "done" });
  await inbox.batch.done;
  assert.deepEqual([...writes].sort(), ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/4"]);
  assert.equal(inbox.loadedItems().length, 1, "Unowned loaded rows are untouched");
  assert.equal(inbox.summary().matching, 0);
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /authorId|Synthetic|example\//);
});
