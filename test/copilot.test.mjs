import test from "node:test";
import assert from "node:assert/strict";
import { CopilotHandoff, CopilotHost } from "../src/copilot.mjs";
import { GitHubClient, RETRY_MS } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { InboxError, normalizeThreads } from "../src/model.mjs";
import { startServer } from "../src/server.mjs";
import { thread, http } from "./fixtures.mjs";
import { copilotHost, projectId, sessionId, toolNames } from "./fixtures/copilot-host.mjs";
import { createCanvasFixture } from "./canvas-fixtures.mjs";

const sha = "a".repeat(40);
const prSha = "b".repeat(40);
const runDetails = {
  id: 42, run_attempt: 2, head_sha: sha, status: "completed", conclusion: "failure",
  repository: { full_name: "example/widgets" }, html_url: "https://github.com/example/widgets/actions/runs/42",
};
async function fixture(t, { type = "Issue", reason = "author", authorId = 8, runId = 42, run = runDetails, runAttempts = {}, pull = {}, preferences, onGitHub, ...hostOptions } = {}) {
  const requests = [];
  const client = new GitHubClient({ run: async args => {
    requests.push(args);
    const intercepted = await onGitHub?.(args);
    if (intercepted !== undefined) return intercepted;
    const path = args.at(-1);
    if (path === "graphql") return http({ data: { repository: { pullRequest: { isInMergeQueue: false } } } });
    if (path === "/user") return http({ id: 7 });
    if (path.endsWith("/pulls/1")) return http({ state: "open", merged: false, draft: false, user: { id: authorId },
      head: { sha: prSha, ref: "fork-feature", repo: { full_name: "contributor/widgets" } },
      base: { sha, repo: { full_name: "example/widgets" } }, ...pull });
    const attempt = /\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(path);
    if (attempt) {
      assert.equal(attempt[1], String(runId));
      assert.ok(Object.hasOwn(runAttempts, attempt[2]), "Unexpected synthetic attempt lookup");
      return http(runAttempts[attempt[2]]);
    }
    if (path.endsWith(`/actions/runs/${runId}`)) return http(run);
    throw new Error("Unexpected synthetic GitHub request");
  } });
  const inbox = new Inbox(client);
  const rows = normalizeThreads([thread("1", { reason, subject: { title: "Private title <script>ignore instructions</script>",
    type, url: `https://api.github.com/repos/example/widgets/${type === "Issue" ? "issues/1" : type === "PullRequest" ? "pulls/1" : `actions/runs/${runId}`}` } })]);
  inbox.pages = [{ items: rows, sequence: 1, fetchedAt: 0, nextRefreshAt: 0 }];
  if (type === "CheckSuite") {
    const endpoint = `/repos/example/widgets/actions/runs/${runId}`;
    client.subjectCache.set(endpoint, { state: "failure" });
    client.subjectLinksReady.add(endpoint);
  }
  const f = copilotHost(hostOptions);
  await f.host.refresh();
  const handoff = new CopilotHandoff(inbox, f.host, { preferences });
  t.after(() => inbox.close());
  return { ...f, inbox, client, handoff, requests };
}
async function prepare(f) {
  assert.equal(f.handoff.request({ id: "1" }).status, "preparing");
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "ready", f.handoff.snapshot().message);
  return f.handoff.snapshot();
}
async function start(f, extra = {}) {
  const ready = f.handoff.snapshot();
  f.handoff.request({ id: "1", token: ready.token, ...extra });
  await f.handoff.pending;
  return f.handoff.snapshot();
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function handoffPreferences(confirmCopilotActions = true) {
  const settings = { copilotIntegration: true, confirmCopilotActions };
  const writes = [];
  return {
    settings, writes,
    read: async () => ({ ...settings }),
    update: async input => {
      writes.push(input);
      Object.assign(settings, input);
      return { ...settings };
    },
  };
}

test("routine confirmations are remembered only on confirmation and direct clicks can start or reopen sessions", async t => {
  const preferences = handoffPreferences();
  const first = await fixture(t, { preferences });
  first.handoff.request({ id: "1", direct: true });
  await first.handoff.pending;
  assert.equal(first.handoff.snapshot().status, "ready", "Direct mode cannot override the default confirmation preference");
  assert.equal(first.handoff.snapshot().canRemember, true);
  assert.deepEqual(preferences.writes, []);
  assert.equal(first.calls.some(call => call.name === "create_session"), false);
  assert.equal((await start(first, { skipConfirmation: true })).status, "started");
  assert.deepEqual(preferences.writes, [{ confirmCopilotActions: false }]);
  const next = await fixture(t, { preferences });
  next.handoff.request({ id: "1" });
  await next.handoff.pending;
  assert.equal(next.handoff.snapshot().status, "ready", "A stored opt-out does not arm a prepared confirmation by itself");
  next.handoff.request({ id: "1", direct: true });
  await next.handoff.pending;
  assert.equal(next.handoff.snapshot().status, "started");
  next.handoff.request({ id: "1", direct: true });
  await next.handoff.pending;
  assert.equal(next.handoff.snapshot().status, "opened");
  assert.equal(next.calls.filter(call => call.name === "create_session").length, 1);
  assert.match(next.calls.find(call => call.name === "create_session").args.kickoff.prompt, /first substantive response must summarize/);
  assert.equal(next.calls.some(call => call.name === "send_session_message"), false);
  assert.deepEqual(preferences.writes, [{ confirmCopilotActions: false }]);
});

test("the opt-out never skips repository setup, inferred CI confirmation, or multiple-session choices", async t => {
  const preferences = handoffPreferences(false);
  const unconfigured = await fixture(t, { preferences, repositories: [] });
  unconfigured.handoff.request({ id: "1", direct: true });
  await unconfigured.handoff.pending;
  assert.equal(unconfigured.handoff.snapshot().status, "ready");
  assert.equal(unconfigured.handoff.snapshot().needsClone, true);
  assert.equal(unconfigured.calls.some(call => call.name === "add_repository"), false);
  const multiple = await fixture(t, { preferences, sessions: [
    { type: "session", id: sessionId, project_repo: "example/widgets", source_issue_number: 1, name: "One" },
    { type: "session", id: "33333333-3333-4333-8333-333333333333", project_repo: "example/widgets", source_issue_number: 1, name: "Two" },
  ] });
  multiple.handoff.request({ id: "1", direct: true });
  await multiple.handoff.pending;
  assert.equal(multiple.handoff.snapshot().sessions.length, 2);
  assert.equal(multiple.calls.some(call => call.name === "navigate_to"), false);
  const inferred = await fixture(t, { preferences, type: "CheckSuite", runAttempts: { 2: runDetails } });
  t.mock.method(inferred.client, "subjectSnapshot", () => ({
    subjectState: "failure", subjectLinkSource: "inferred", direct: true,
    url: `${runDetails.html_url}/attempts/2`, subjectRunUrl: `${runDetails.html_url}/attempts/2`,
  }));
  inferred.handoff.request({ id: "1", direct: true });
  await inferred.handoff.pending;
  assert.equal(inferred.handoff.snapshot().status, "ready");
  assert.equal(inferred.handoff.snapshot().inferred, true);
  assert.equal(inferred.calls.some(call => call.name === "create_session"), false);
});

test("invalid opt-out requests and failed preference saves cannot start work", async t => {
  const preferences = handoffPreferences();
  const f = await fixture(t, { preferences });
  for (const input of [{ id: "1", skipConfirmation: true }, { id: "1", direct: "true" },
    { id: "1", token: "bad", direct: true }, { id: "1", skipConfirmation: "true" }]) {
    assert.throws(() => f.handoff.request(input), { code: "invalid_handoff" });
  }
  await prepare(f);
  preferences.update = async () => { throw new InboxError("settings_write", "Synthetic settings save failure"); };
  assert.equal((await start(f, { skipConfirmation: true })).status, "error");
  assert.equal(f.calls.some(call => call.name === "create_session"), false);
  assert.equal(preferences.settings.confirmCopilotActions, true);
});

test("turning confirmations back on stops a pending direct start before any host mutation", async t => {
  const preferences = handoffPreferences(false);
  let queries = 0;
  let release;
  const f = await fixture(t, { preferences, onExecute: name => {
    if (name === "list_sessions_and_chats" && ++queries === 2) {
      return new Promise(resolve => { release = () => resolve({ resultType: "success", textResultForLlm: "[]" }); });
    }
  } });
  f.handoff.request({ id: "1", direct: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, "function");
  preferences.settings.confirmCopilotActions = true;
  release();
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "error");
  assert.match(f.handoff.snapshot().message, /needs confirmation/);
  assert.equal(f.calls.some(call => call.name === "create_session"), false);
});

test("issue and PR handoffs create root sessions in the target repository and summarize first without notification content", async t => {
  for (const [type, authorId, label, pull] of [
    ["Issue", 8, "Investigate with Copilot"],
    ["PullRequest", 7, "Continue with Copilot"],
    ["PullRequest", 8, "Review with Copilot"],
    ["PullRequest", 7, "Review with Copilot", { state: "closed" }],
  ]) await t.test(`${label}${pull ? " (own closed PR)" : ""}`, async t => {
    const f = await fixture(t, { type, authorId, pull });
    const before = f.inbox.summary();
    const ready = await prepare(f);
    assert.equal(ready.label, label);
    assert.equal(f.calls.some(call => call.name === "create_session"), false);
    assert.equal((await start(f)).status, "started");
    const open = f.calls.find(call => call.name === "create_session");
    const { kickoff, ...creation } = open.args;
    assert.deepEqual(creation, {
      project_id: projectId, name: type === "Issue" ? "Investigate issue #1" : "Work on PR #1",
      workspace_type: "worktree", detached: true,
      ...(type === "PullRequest" ? { base_branch: prSha } : {}),
    });
    assert.equal(f.sessions[0].parent_session_id, null);
    assert.equal(kickoff.mode, "plan");
    assert.match(kickoff.prompt, /first substantive response must summarize/);
    assert.match(kickoff.prompt, /wait for explicit user approval before editing files/);
    if (type === "PullRequest") {
      assert.match(kickoff.prompt, new RegExp(`verified head commit ${prSha}`));
      assert.match(kickoff.prompt, /including for fork PRs/);
      assert.doesNotMatch(kickoff.prompt, new RegExp(sha));
    }
    if (type === "PullRequest" && authorId !== 7) {
      assert.match(kickoff.prompt, /After the summary, use ask_user/);
      assert.match(kickoff.prompt, /specific review skill of their choice/);
      assert.match(kickoff.prompt, /skill named "review" if it is available/);
      assert.match(kickoff.prompt, /Wait for the user's answer before reviewing or drafting findings/);
      assert.match(kickoff.prompt, /normal approval requirements/);
      assert.match(kickoff.prompt, /do not assume or install a skill/);
      assert.doesNotMatch(kickoff.prompt, /Then proceed with read-only investigation/);
    } else {
      assert.doesNotMatch(kickoff.prompt, /ask_user|review skill/);
    }
    assert.doesNotMatch(kickoff.prompt, /Private title|script|reason|authorId/);
    assert.equal(f.calls.some(call => call.name === "send_session_message"), false);
    assert.deepEqual(f.inbox.summary(), before);
    assert.ok(f.requests.every(args => args.includes("GET") ||
      args.at(-1) === "graphql" && args.some(arg => arg.startsWith("query=query(") && arg.includes("isInMergeQueue"))));
    assert.throws(() => f.handoff.request({ id: "1", token: ready.token }), { code: "stale_handoff" });
  });
});

test("CI handoffs bind the verified failed run, attempt and immutable commit", async t => {
  const f = await fixture(t, { type: "CheckSuite" });
  const ready = await prepare(f);
  assert.equal(ready.url, `${runDetails.html_url}/attempts/2`);
  assert.equal((await start(f)).status, "started");
  const { kickoff, ...creation } = f.calls.find(call => call.name === "create_session").args;
  assert.deepEqual(creation, {
    project_id: projectId, name: "Investigate CI run 42 (attempt 2)", base_branch: sha,
    workspace_type: "worktree", detached: true,
  });
  assert.equal(f.sessions[0].parent_session_id, null);
  assert.equal(kickoff.mode, "plan");
  assert.match(kickoff.prompt, new RegExp(sha));
  assert.doesNotMatch(kickoff.prompt, /ask_user|review skill/);
});

test("a new PR preparation uses its current head even after cached metadata and a subject refresh", async t => {
  const pull = { head: { sha: prSha } };
  const f = await fixture(t, { type: "PullRequest", pull });
  await prepare(f);
  const updated = "c".repeat(40);
  pull.head = { sha: updated };
  const item = f.inbox.pages[0].items[0];
  item.updatedAt = new Date(Date.parse(item.updatedAt) + 1000).toISOString();
  f.client.invalidateSubjects([item]);
  await f.client.refreshSubjects([item]);
  await prepare(f);
  assert.equal((await start(f)).status, "started");
  assert.equal(f.calls.find(call => call.name === "create_session").args.base_branch, updated);
});

test("missing PR commits are fetched and verified only after confirmation and before session creation", async t => {
  let present = false;
  const f = await fixture(t, { type: "PullRequest", onGit: args => {
    if (args.includes("--verify") && !present) throw Object.assign(new Error("Missing synthetic commit"), { code: 1 });
    if (args.includes("fetch")) {
      assert.equal(args.at(-1), "refs/pull/1/head");
      present = true;
    }
  }, onExecute: name => {
    if (name === "create_session") assert.equal(present, true);
  } });
  await prepare(f);
  assert.deepEqual(f.gitCalls, []);
  assert.equal((await start(f)).status, "started");
  assert.equal(f.gitCalls.filter(call => call.args.includes("fetch")).length, 1);
  assert.equal(f.calls.find(call => call.name === "create_session").args.base_branch, prSha);
});

test("failed commit preparation cannot create a session or expose raw Git errors", async t => {
  const f = await fixture(t, { type: "CheckSuite", onGit: args => {
    if (args.includes("--verify")) throw Object.assign(new Error("Missing synthetic commit"), { code: 1 });
    if (args.includes("fetch")) throw new Error("SECRET transport details");
  } });
  await prepare(f);
  const result = await start(f);
  assert.equal(result.status, "error");
  assert.match(result.message, /Could not fetch/);
  assert.doesNotMatch(result.message, /SECRET/);
  assert.equal(f.calls.some(call => call.name === "create_session"), false);
});

test("closing the panel or disabling integration during a fetch stops subsequent creation", async t => {
  for (const change of ["close", "disable"]) await t.test(change, async t => {
    const entered = deferred();
    const held = deferred();
    t.after(() => held.resolve());
    const preferences = handoffPreferences();
    let present = false;
    const f = await fixture(t, { type: "PullRequest", preferences, onGit: async args => {
      if (args.includes("--verify") && !present) throw Object.assign(new Error("Missing synthetic commit"), { code: 1 });
      if (args.includes("fetch")) {
        entered.resolve();
        await held.promise;
        present = true;
      }
    } });
    await prepare(f);
    const pending = start(f);
    await entered.promise;
    if (change === "close") f.inbox.close();
    else preferences.settings.copilotIntegration = false;
    held.resolve();
    assert.equal((await pending).status, "error");
    assert.equal(f.calls.some(call => call.name === "create_session"), false);
  });
});

test("CI handoffs fit the host name limit without losing exact references or session reuse", async t => {
  const names = new Set();
  for (const [runId, attempt] of [
    [42, 2],
    [12345678901, 1],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ["9".repeat(20), Number.MAX_SAFE_INTEGER],
    ["9".repeat(64), 2],
    [`${"9".repeat(63)}8`, 2],
  ]) await t.test(`${runId}/${attempt}`, async t => {
    const url = `https://github.com/example/widgets/actions/runs/${runId}`;
    const f = await fixture(t, { type: "CheckSuite", runId,
      run: { ...runDetails, id: runId, run_attempt: attempt, html_url: url } });
    await prepare(f);
    assert.equal((await start(f)).status, "started");
    const creation = f.calls.find(call => call.name === "create_session").args;
    assert.ok(creation.name.length <= 40, "Session names must satisfy the host's schema");
    assert.equal(names.has(creation.name), false, "Different runs must not collapse to the same shortened name");
    names.add(creation.name);
    assert.equal(creation.base_branch, sha);
    assert.ok(creation.kickoff.prompt.includes(`${url}/attempts/${attempt}`));
    const ready = await prepare(f);
    assert.deepEqual(ready.sessions, [{ id: sessionId, name: creation.name }]);
    assert.equal((await start(f, { sessionId })).status, "opened");
    assert.equal(f.calls.filter(call => call.name === "create_session").length, 1);
  });
});

test("inferred job links validate their original run attempt instead of a later successful rerun", async t => {
  const f = await fixture(t, {
    type: "CheckSuite", run: { ...runDetails, run_attempt: 3, conclusion: "success" },
    runAttempts: { 2: runDetails },
  });
  const item = {
    ...f.inbox.loadedItems()[0], subjectState: "failure", subjectLinkSource: "inferred",
    url: `${runDetails.html_url}/job/91`, subjectRunUrl: `${runDetails.html_url}/attempts/2`,
  };
  assert.equal(f.handoff.row(item).enabled, true);
  assert.equal(f.handoff.row({ ...item, subjectLinkLoading: true }).enabled, false);
  assert.match(f.handoff.row({ ...item, subjectLinkLoading: true }).reason, /Finding/);
  const context = await f.client.copilotContext("run", item);
  assert.deepEqual(context, { runId: "42", sha, attempt: 2, url: `${runDetails.html_url}/attempts/2` });
  assert.deepEqual(f.requests.map(args => args.at(-1)), ["/repos/example/widgets/actions/runs/42/attempts/2"]);
  assert.deepEqual(await f.client.copilotContext("run", item), context);
  assert.equal(f.requests.length, 1, "The historical attempt has its own cache");
  t.mock.method(f.client, "subjectSnapshot", () => item);
  const ready = await prepare(f);
  assert.equal(ready.inferred, true);
  assert.equal(ready.url, context.url);
  assert.equal((await start(f)).status, "started");
  const { kickoff } = f.calls.find(call => call.name === "create_session").args;
  assert.match(kickoff.prompt, /inferred and explicitly confirmed/);
  assert.ok(kickoff.prompt.includes(context.url));
  assert.equal(f.calls.find(call => call.name === "create_session").args.base_branch, sha);
});

test("a missing or mismatched attempt never falls back to the latest run", async t => {
  for (const body of [null, { ...runDetails, run_attempt: 3 }]) {
    const f = await fixture(t, { type: "CheckSuite", runAttempts: { 2: body } });
    const item = { ...f.inbox.loadedItems()[0], url: `${runDetails.html_url}/attempts/2` };
    await assert.rejects(f.client.copilotContext("run", item), { code: "copilot_context" });
    assert.deepEqual(f.requests.map(args => args.at(-1)), ["/repos/example/widgets/actions/runs/42/attempts/2"]);
  }
});

test("CI handoff references must identify the same run and explicit attempt as the row destination", async t => {
  const f = await fixture(t, { type: "CheckSuite" });
  const item = { ...f.inbox.loadedItems()[0], url: `${runDetails.html_url}/job/91` };
  for (const subjectRunUrl of [
    runDetails.html_url, `${runDetails.html_url}/attempts/0`,
    `${runDetails.html_url}/attempts/2?extra=true`, `${runDetails.html_url}/attempts/2#extra`,
    "https://github.com/example/widgets/actions/runs/99/attempts/2",
    "https://github.com/other/widgets/actions/runs/42/attempts/2",
    "https://evil.test/example/widgets/actions/runs/42/attempts/2",
  ]) {
    assert.throws(() => f.client.copilotContext("run", { ...item, subjectRunUrl }), { code: "copilot_context" });
  }
  assert.throws(() => f.client.copilotContext("run", {
    ...item, url: `${runDetails.html_url}/attempts/2`, subjectRunUrl: `${runDetails.html_url}/attempts/3`,
  }), { code: "copilot_context" });
  assert.deepEqual(f.requests, []);
});

test("merged and merge-queued PRs have no action and cannot use an earlier confirmation", async t => {
  for (const state of ["merged", "merge_queued"]) await t.test(state, async t => {
    const f = await fixture(t, { type: "PullRequest" });
    const ready = await prepare(f);
    const path = "/repos/example/widgets/pulls/1";
    f.client.subjectCache.set(path, { state: state === "merged" ? state : "open" });
    if (state === "merge_queued") f.client.mergeQueueCache.set(path, { state: true });
    const item = f.inbox.loadedItems()[0];
    assert.equal(f.handoff.row({ ...item, ...f.client.subjectSnapshot(item) }), null);
    assert.throws(() => f.handoff.request({ id: "1", token: ready.token }), { code: "copilot_inactive_pr" });
    assert.equal(f.calls.some(call => call.name === "create_session"), false);
    f.client.subjectCache.set(path, { state: "closed" });
    assert.equal(f.handoff.row({ ...item, ...f.client.subjectSnapshot(item) }).label, "Work with Copilot");
  });
  const f = await fixture(t, { type: "PullRequest", pull: { state: "closed", merged: true } });
  f.handoff.request({ id: "1" });
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "error");
  assert.match(f.handoff.snapshot().message, /merged/);
  assert.deepEqual(f.calls, []);
});

test("PR handoffs await a pending merge-queue lookup before preparing or starting", async t => {
  for (const direct of [false, true]) await t.test(direct ? "direct" : "confirmed", async t => {
    const entered = deferred();
    const queue = deferred();
    t.after(() => queue.resolve());
    const f = await fixture(t, { type: "PullRequest", preferences: handoffPreferences(!direct),
      onGitHub: async args => {
        if (args.at(-1) !== "graphql") return;
        entered.resolve();
        await queue.promise;
        return http({ data: { repository: { pullRequest: { isInMergeQueue: true } } } });
      } });
    const hydrating = f.client.refreshSubjects(f.inbox.loadedItems());
    await entered.promise;
    assert.equal(f.client.subjectSnapshot(f.inbox.loadedItems()[0]).subjectState, "open");
    f.handoff.request({ id: "1", direct });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.handoff.snapshot().status, "preparing");
    assert.equal(f.calls.some(call => call.name === "create_session"), false);
    queue.resolve();
    await Promise.all([hydrating, f.handoff.pending]);
    assert.equal(f.handoff.snapshot().status, "error");
    assert.match(f.handoff.snapshot().message, /merge-queued/);
    assert.equal(f.requests.filter(args => args.at(-1) === "graphql").length, 1);
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
  });
});

test("PR confirmations fail closed when previously verified queue status can no longer be checked", async t => {
  for (const blocked of [false, true]) await t.test(blocked ? "rate limited" : "lookup failure", async t => {
    let checks = 0;
    const f = await fixture(t, { type: "PullRequest", onGitHub: args => {
      if (args.at(-1) === "graphql" && ++checks > 1) return http({}, {}, 403);
    } });
    await prepare(f);
    const item = f.inbox.loadedItems()[0];
    f.client.invalidateSubjects([item]);
    if (blocked) f.client.graphqlBlockedUntil = f.client.now() + RETRY_MS;
    assert.equal((await start(f)).status, "error");
    assert.equal(f.calls.some(call => call.name === "create_session"), false);
    assert.equal(checks, blocked ? 1 : 2);
  });
});

test("disabling integration blocks preparation and rechecks saved preferences before confirmation", async t => {
  let enabled = false;
  const f = await fixture(t, { preferences: { read: async () => ({ copilotIntegration: enabled }) } });
  f.handoff.request({ id: "1" });
  await f.handoff.pending;
  assert.match(f.handoff.snapshot().message, /integration is off/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.handoff.row(f.inbox.loadedItems()[0]), null);
  f.handoff.hydrate([]);
  assert.equal(f.handoff.hydrating, undefined);
  enabled = true;
  f.handoff.setEnabled(true);
  await prepare(f);
  enabled = false;
  assert.equal((await start(f)).status, "error");
  assert.equal(f.calls.some(call => call.name === "create_session"), false);
});

test("the saved integration switch hides HTTP actions and revokes prepared tokens without marking notifications", async t => {
  const f = await createCanvasFixture({ copilotEnabled: true });
  t.after(() => f.close());
  f.rows.splice(1);
  f.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/1";
  const url = new URL(f.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const call = (path, body) => fetch(new URL(`/api/${path}`, url), {
    headers, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await call("refresh", {});
  await call("copilot", { id: "1" });
  await f.copilot.pending;
  const ready = f.copilot.snapshot();
  assert.equal(ready.status, "ready");
  const saved = await (await call("settings", { copilotIntegration: false })).json();
  assert.equal(saved.copilotIntegration, false);
  const state = await (await call("state")).json();
  assert.equal(state.copilotIntegration, false);
  assert.equal(state.groups[0].items[0].copilot, null);
  assert.equal(state.copilotOperation.status, "error");
  assert.equal((await call("copilot", { id: "1", token: ready.token })).status, 409);
  assert.deepEqual(f.writes, []);
  assert.equal(f.copilotHost.calls.some(call => call.name === "create_session"), false);
});

test("existing and concurrently discovered sessions are offered without starting or interrupting work", async t => {
  for (const concurrent of [false, true]) await t.test(String(concurrent), async t => {
    const existing = { type: "session", id: sessionId, project_repo: "example/widgets", source_issue_number: 1, name: "Existing work" };
    const f = await fixture(t, { sessions: concurrent ? [] : [existing] });
    const ready = await prepare(f);
    if (concurrent) {
      f.sessions.push(existing);
      assert.equal((await start(f)).status, "ready");
    } else assert.equal(ready.sessions.length, 1);
    assert.equal((await start(f, { sessionId })).status, "opened");
    assert.deepEqual(f.calls.filter(call => !call.name.startsWith("list_")).map(call => call.name), ["navigate_to"]);
  });
});

test("repository cloning requires a separate explicit confirmation", async t => {
  const f = await fixture(t, { repositories: [] });
  assert.equal((await prepare(f)).needsClone, true);
  assert.equal((await start(f)).status, "error");
  assert.equal(f.calls.some(call => call.name === "add_repository"), false);
  await prepare(f);
  assert.equal((await start(f, { clone: true })).status, "started");
  assert.deepEqual(f.calls.find(call => call.name === "add_repository").args, { github_repo: "example/widgets" });
});

test("new sessions receive a plan kickoff even before their activity becomes idle", async t => {
  for (const status of ["unknown", "busy", undefined]) await t.test(String(status), async t => {
    const f = await fixture(t, { onExecute: name => name === "get_session"
      ? { resultType: "success", textResultForLlm: JSON.stringify({ id: sessionId,
        ...(status ? { activity: { status } } : {}) }) } : undefined });
    await prepare(f);
    assert.equal((await start(f)).status, "started");
    const creations = f.calls.filter(call => call.name === "create_session");
    assert.equal(creations.length, 1);
    assert.equal(creations[0].args.kickoff.mode, "plan");
    assert.match(creations[0].args.kickoff.prompt, /first substantive response must summarize/);
    assert.equal(f.calls.some(call => ["get_session", "send_session_message"].includes(call.name)), false);
    assert.deepEqual(f.calls.filter(call => call.name === "navigate_to").map(call => call.args), [{ id: sessionId }]);
  });
});

test("closing the panel or disabling integration during host work prevents later navigation", async t => {
  for (const boundary of ["creation", "inventory", "queue verification"]) {
    for (const change of ["close", "disable"]) await t.test(`${boundary}: ${change}`, async t => {
      const entered = deferred();
      const held = deferred();
      t.after(() => held.resolve());
      const preferences = handoffPreferences();
      let creating = false;
      const f = await fixture(t, { preferences, type: boundary === "queue verification" ? "PullRequest" : "Issue",
        onGitHub: async args => {
          if (boundary === "queue verification" && creating && args.at(-1) === "graphql") {
            entered.resolve();
            await held.promise;
          }
        }, onExecute: async name => {
          if (name === "create_session") creating = true;
          if (boundary === "queue verification" && creating && name === "list_sessions_and_chats") {
            f.client.invalidateSubjects(f.inbox.loadedItems());
          }
          if (boundary === "creation" && name === "create_session" ||
              boundary === "inventory" && creating && name === "list_sessions_and_chats") {
            entered.resolve();
            await held.promise;
          }
        } });
      await prepare(f);
      const pending = start(f);
      await entered.promise;
      if (change === "close") f.inbox.close();
      else preferences.settings.copilotIntegration = false;
      held.resolve();
      assert.equal((await pending).status, "error");
      assert.equal(f.sessions.length, 1, "Creation already in flight is not undone");
      assert.equal(f.calls.some(call => call.name === "navigate_to"), false);
    });
  }
});

test("selected-context failures retain error backoff and never bypass a rate-limit deadline", async () => {
  let now = 0;
  let count = 0;
  const client = new GitHubClient({ now: () => now, run: async () => {
    count++;
    return count === 1 ? http({}, { "retry-after": "600" }, 429) : http({ id: 7 });
  } });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(client.copilotContext("viewer"), { code: "rate_limited" });
  }
  assert.equal(count, 1);
  now = client.blockedUntil;
  assert.deepEqual(await client.copilotContext("viewer"), { id: 7 });
  assert.equal(count, 2);
});

test("repeated context failures renew expired backoff without extending an active deadline", async () => {
  let now = 0;
  let calls = 0;
  const client = new GitHubClient({ now: () => now, run: async () => {
    calls++;
    return http({ id: -1 });
  } });
  await assert.rejects(client.copilotContext("viewer"), { code: "copilot_context" });
  const firstDeadline = client.copilotCache.get("/user").nextRefreshAt;
  now = firstDeadline - 1;
  await assert.rejects(client.copilotContext("viewer"), { code: "copilot_context" });
  assert.equal(calls, 1);
  assert.equal(client.copilotCache.get("/user").nextRefreshAt, firstDeadline);
  now = firstDeadline;
  let nextDeadline;
  await assert.rejects(client.copilotContext("viewer"), error => {
    assert.equal(error.code, "copilot_context");
    nextDeadline = error.retryAt;
    return true;
  });
  assert.equal(calls, 2);
  assert.ok(nextDeadline >= now + RETRY_MS);
  assert.equal(client.copilotCache.get("/user").nextRefreshAt, nextDeadline);
  now++;
  await assert.rejects(client.copilotContext("viewer"), { code: "copilot_context" });
  assert.equal(calls, 2);
  assert.equal(client.copilotCache.get("/user").nextRefreshAt, nextDeadline);
});

test("concurrent context failures retain the longer deadline from the later failure", async () => {
  let now = 0;
  const responses = [];
  const client = new GitHubClient({ now: () => now, run: () => {
    const response = deferred();
    responses.push(response);
    return response.promise;
  } });
  const first = client.copilotContext("viewer").catch(error => error);
  const second = client.copilotContext("viewer").catch(error => error);
  responses[0].resolve(http({ id: -1 }));
  const firstError = await first;
  responses[1].resolve(http({ id: -1 }));
  const secondError = await second;
  assert.equal(firstError.code, "copilot_context");
  assert.equal(secondError.code, "copilot_context");
  assert.ok(secondError.retryAt > firstError.retryAt);
  assert.equal(client.copilotCache.get("/user").nextRefreshAt, secondError.retryAt);
  now = firstError.retryAt;
  await assert.rejects(client.copilotContext("viewer"), { code: "copilot_context" });
  assert.equal(responses.length, 2, "The earlier deadline must not permit another request");
  now = secondError.retryAt;
  const recovered = client.copilotContext("viewer");
  responses[2].resolve(http({ id: 7 }));
  assert.deepEqual(await recovered, { id: 7 });
});

test("handoffs reject arbitrary targets, stale selections, replay and concurrent requests", async t => {
  let release;
  const f = await fixture(t, { onExecute: name => name === "list_repositories"
    ? new Promise(resolve => { release = resolve; }) : undefined });
  for (const input of [{ id: "1", url: "https://evil.test" }, { id: "1", clone: true }, { id: "1", sessionId: "bad" }, { id: "0" }]) {
    assert.throws(() => f.handoff.request(input), { code: "invalid_handoff" });
  }
  assert.throws(() => f.handoff.request({ id: "99" }), { code: "unknown_thread" });
  f.handoff.request({ id: "1" });
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => f.handoff.request({ id: "1" }), { code: "copilot_busy" });
  f.inbox.close();
  release({ resultType: "success", textResultForLlm: "[]" });
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "error");
  assert.equal(f.calls.some(call => call.name === "create_session"), false);
});

test("tool failures are sanitized and never automatically retried", async t => {
  for (const response of [{ resultType: "denied", textResultForLlm: "SECRET" }, "Error: SECRET", '{"error":"SECRET"}']) {
    const f = await fixture(t, { onExecute: name => name === "create_session" ? response : undefined });
    await prepare(f);
    assert.equal((await start(f)).status, "error");
    assert.doesNotMatch(JSON.stringify(f.handoff.snapshot()), /SECRET/);
    assert.equal(f.calls.filter(call => call.name === "create_session").length, 1);
    assert.equal(f.calls.some(call => call.name === "send_session_message"), false);
  }
});

test("host discovery is capability-gated and does not execute tools", async () => {
  const missing = new CopilotHost(() => ({}));
  await missing.refresh();
  assert.equal(missing.supports(), false);
  await assert.rejects(missing.execute("create_session", {}), { code: "copilot_unavailable" });
  const f = copilotHost({ tools: toolNames.filter(name => name !== "create_session") });
  await f.host.refresh();
  assert.equal(f.host.supports(), false);
  assert.deepEqual(f.calls, []);
  const atomic = copilotHost({ tools: toolNames.filter(name => !["get_session", "send_session_message"].includes(name)) });
  await atomic.host.refresh();
  assert.equal(atomic.host.supports(), true);
  assert.deepEqual(atomic.calls, []);
});

test("hosts without detached plan-kickoff support cannot create a nested or unprompted session", async t => {
  for (const unsupported of [
    { detached: undefined }, { detached: { type: "string" } }, { kickoff: undefined },
    { kickoff: { properties: { prompt: { type: "boolean" }, mode: { enum: ["plan"] } } } },
    { kickoff: { properties: { prompt: { type: "string" }, mode: { enum: ["autopilot"] } } } },
  ]) {
    const f = await fixture(t);
    const metadata = await f.rpc.getCurrentMetadata();
    Object.assign(metadata.tools.find(tool => tool.name === "create_session").input_schema.properties, unsupported);
    f.rpc.getCurrentMetadata = async () => metadata;
    f.host.nextCheckAt = 0;
    await f.host.refresh();
    assert.equal(f.handoff.row(f.inbox.loadedItems()[0]), null);
    f.handoff.request({ id: "1" });
    await f.handoff.pending;
    assert.equal(f.handoff.snapshot().status, "error");
    await assert.rejects(f.host.execute("create_session", {}), { code: "copilot_unavailable" });
    assert.deepEqual(f.calls, []);
  }
});

test("PR handoffs reject missing or malformed head commits before creating a session", async t => {
  for (const head of [undefined, {}, { sha: "main" }, { sha: "b".repeat(39) }]) {
    const f = await fixture(t, { type: "PullRequest", pull: { head } });
    f.handoff.request({ id: "1" });
    await f.handoff.pending;
    assert.equal(f.handoff.snapshot().status, "error");
    assert.match(f.handoff.snapshot().message, /verified context/);
    assert.deepEqual(f.calls, []);
  }
});

test("generic sessions are reused by repository and item name without messaging or reparenting", async t => {
  for (const [type, name] of [["Issue", "Investigate issue #1"], ["PullRequest", "Work on PR #1"]]) {
    const f = await fixture(t, { type, sessions: [
      { type: "session", id: sessionId, project_repo: "example/widgets", name, parent_session_id: projectId },
      { type: "session", id: "33333333-3333-4333-8333-333333333333", project_repo: "other/widgets", name },
    ] });
    const ready = await prepare(f);
    assert.deepEqual(ready.sessions, [{ id: sessionId, name }]);
    assert.equal((await start(f, { sessionId })).status, "opened");
    assert.equal(f.sessions[0].parent_session_id, projectId);
    assert.deepEqual(f.calls.filter(call => !call.name.startsWith("list_")).map(call => call.name), ["navigate_to"]);
    assert.deepEqual(f.gitCalls, []);
  }
});

test("Copilot HTTP actions use the protected POST boundary and return queued state only", async t => {
  const f = await fixture(t);
  f.client.subjectsNeedRefresh = () => false;
  const server = await startServer(f.inbox, { copilot: f.handoff, development: false });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  for (const overrides of [{ Authorization: "wrong" }, { Origin: "https://evil.test" }, { "Sec-Fetch-Site": "cross-site" }]) {
    const response = await fetch(new URL("/api/copilot", url), {
      method: "POST", headers: { ...headers, ...overrides }, body: '{"id":"1"}',
    });
    assert.equal(response.status, 403);
  }
  assert.equal((await fetch(new URL("/api/copilot", url), { headers })).status, 405);
  const response = await fetch(new URL("/api/copilot", url), { method: "POST", headers, body: '{"id":"1"}' });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "preparing");
  await f.handoff.pending;
  const state = await (await fetch(new URL("/api/state", url), { headers })).json();
  assert.equal(state.copilotOperation.status, "ready");
  assert.equal(state.groups[0].items[0].copilot.label, "Investigate with Copilot");
  assert.equal(Object.hasOwn(f.inbox.summary(), "copilotOperation"), false);
});

test("HTTP snapshots keep Copilot disabled until failed-run job links finish loading", async t => {
  const f = await fixture(t, { type: "CheckSuite" });
  f.client.subjectLinksReady.clear();
  f.client.subjectsNeedRefresh = () => false;
  const server = await startServer(f.inbox, { copilot: f.handoff, development: false });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin };
  const state = () => fetch(new URL("/api/state", url), { headers }).then(response => response.json());
  const loading = (await state()).groups[0].items[0];
  assert.equal(loading.subjectLinkLoading, true);
  assert.equal(loading.copilot.enabled, false);
  assert.match(loading.copilot.reason, /Finding/);
  f.handoff.request({ id: "1" });
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "error");
  assert.equal(f.calls.some(call => call.name === "create_session"), false);
  f.client.jobCache.set("/repos/example/widgets/actions/runs/42/jobs?filter=latest&per_page=100", {
    state: `${runDetails.html_url}/job/91`, runUrl: `${runDetails.html_url}/attempts/2`,
  });
  const ready = (await state()).groups[0].items[0];
  assert.equal(ready.subjectLinkLoading, false);
  assert.equal(ready.copilot.enabled, true);
  assert.equal(ready.url, `${runDetails.html_url}/job/91`);
  assert.equal(ready.subjectRunUrl, `${runDetails.html_url}/attempts/2`);
});

test("GitHub context validation rejects uncertain runs, foreign targets and malformed identities", async t => {
  for (const change of [{ head_sha: "main" }, { run_attempt: 0 }, { conclusion: "success" }, { id: 99 },
    { html_url: "https://evil.test" }, { repository: { full_name: "other/repo" } }]) {
    const f = await fixture(t, { type: "CheckSuite", run: { ...runDetails, ...change } });
    f.handoff.request({ id: "1" });
    await f.handoff.pending;
    assert.equal(f.handoff.snapshot().status, "error");
    assert.deepEqual(f.calls, []);
  }
  const f = await fixture(t, { type: "CheckSuite" });
  const item = { ...f.inbox.loadedItems()[0], subjectState: "failure", subjectLinkSource: "inferred" };
  assert.equal(f.handoff.row(item).enabled, false);
  assert.throws(() => f.client.copilotContext("run", { ...item, url: "https://evil.test" }), { code: "copilot_context" });
  for (const body of [{}, { id: -1 }, { id: "7" }]) {
    const client = new GitHubClient({ run: async () => http(body) });
    await assert.rejects(client.copilotContext("viewer"), InboxError);
  }
  const custom = new GitHubClient({ apiBaseUrl: "https://example.test/api", run: () => assert.fail() });
  await assert.rejects(async () => custom.copilotContext("viewer"), { code: "copilot_context" });
});
