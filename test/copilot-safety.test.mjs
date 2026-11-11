import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, RETRY_MS } from "../src/provider/github.mjs";
import { InboxError } from "../src/shared/model.mjs";
import { startServer } from "../src/provider/server.mjs";
import { http } from "./fixtures.mjs";
import { sessionId } from "./fixtures/copilot-host.mjs";
import { createCanvasFixture } from "./canvas-fixtures.mjs";
import { sha, runDetails, releaseDetails, commitDetails, fixture, prepare, start, deferred, handoffPreferences } from "./fixtures/copilot-handoff.mjs";

test("preparation overlaps independent GitHub and host inventory reads", async t => {
  const viewerEntered = deferred();
  const viewer = deferred();
  const repositoryEntered = deferred();
  const repositories = deferred();
  let pullRead = false;
  t.after(() => { viewer.resolve(http({ id: 7 })); repositories.resolve(); });
  const f = await fixture(t, { type: "PullRequest",
    onGitHub: args => {
      if (args.at(-1) === "/user") {
        viewerEntered.resolve();
        return viewer.promise;
      }
      if (args.at(-1).endsWith("/pulls/1")) pullRead = true;
    },
    onExecute: async name => {
      if (name === "list_repositories") {
        repositoryEntered.resolve();
        await repositories.promise;
      }
    },
  });
  f.handoff.request({ id: "1" });
  await viewerEntered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pullRead, true, "PR metadata should not wait for identity");
  viewer.resolve(http({ id: 7 }));
  await repositoryEntered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(call => call.name === "list_sessions_and_chats"), true,
    "Session inventory should not wait for repository inventory");
  assert.ok(f.handoff.pending);
  repositories.resolve();
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "ready");
  assert.equal(f.calls.some(call => call.name === "create_session"), false);
});

test("start overlaps PR and inventory reads but drains them before reporting a failure", async t => {
  const entered = deferred();
  const pull = deferred();
  const repositories = deferred();
  let starting = false;
  let repositoryRead = false;
  t.after(() => { pull.resolve(http({}, {}, 404)); repositories.resolve(); });
  const f = await fixture(t, { type: "PullRequest",
    onGitHub: args => {
      if (starting && args.at(-1).endsWith("/pulls/1")) {
        entered.resolve();
        return pull.promise;
      }
    },
    onExecute: async name => {
      if (starting && name === "list_repositories") {
        repositoryRead = true;
        await repositories.promise;
      }
    },
  });
  await prepare(f);
  starting = true;
  const pending = start(f);
  await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(repositoryRead, true);
  assert.equal(f.calls.filter(call => call.name === "list_sessions_and_chats").length, 2);
  pull.resolve(http({}, {}, 404));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.handoff.pending, "A failed read must not release a handoff while sibling reads are pending");
  assert.throws(() => f.handoff.request({ id: "1" }), { code: "copilot_busy" });
  repositories.resolve();
  assert.equal((await pending).status, "error");
  assert.deepEqual(f.gitCalls, []);
  assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
  assert.equal(f.handoff.pending, undefined);
});

test("routine confirmations are remembered only on confirmation and existing sessions always require a choice", async t => {
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
  assert.equal(next.handoff.snapshot().status, "ready");
  assert.equal(next.calls.filter(call => call.name === "navigate_to").length, 1);
  assert.equal((await start(next, { sessionId })).status, "opened");
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

test("closing an issue during final session discovery prevents the prepared investigation", async t => {
  let queries = 0;
  const f = await fixture(t, { onExecute: name => {
    if (name === "list_sessions_and_chats" && ++queries === 3) {
      f.client.subjectCache.set("/repos/example/widgets/issues/1", { state: "not_planned" });
    }
  } });
  await prepare(f);
  assert.equal((await start(f)).status, "error");
  assert.match(f.handoff.snapshot().message, /issue's state changed/);
  assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
});

test("new sessions revalidate context after setup, checkout, and final session discovery", async t => {
  for (const [type, boundary] of [
    ["Issue", "setup"], ["Issue", "discovery"], ["PullRequest", "checkout"],
    ["PullRequest", "discovery"], ["Release", "setup"], ["Release", "discovery"], ["Commit", "checkout"],
  ]) await t.test(`${type}/${boundary}`, async t => {
    const issue = { state: "open" };
    const pull = { state: "open", merged: false };
    const release = { ...releaseDetails };
    const commit = { ...commitDetails };
    let queries = 0;
    let changed = false;
    const changeContext = () => {
      changed = true;
      issue.state = "closed";
      Object.assign(pull, { state: "closed", merged: true });
      Object.assign(release, { tag_name: "v2.0", html_url: "https://github.com/example/widgets/releases/tag/v2.0" });
      commit.sha = sha.slice(0, 9) + "b".repeat(31);
      commit.html_url = `https://github.com/example/widgets/commit/${commit.sha}`;
    };
    const f = await fixture(t, { type, issue, pull, release, commit, commitRef: sha.slice(0, 9),
      ...(boundary === "setup" ? { repositories: [] } : {}),
      onExecute: name => {
        if (name === "add_repository" && boundary === "setup") changeContext();
        if (name === "list_sessions_and_chats" && ++queries === 3 && boundary === "discovery") changeContext();
      },
      onGit: args => {
        if (args.includes("--verify") && boundary === "checkout") changeContext();
      },
    });
    await prepare(f);
    const result = await start(f, boundary === "setup" ? { clone: true } : {});
    assert.equal(changed, true);
    assert.equal(result.status, "error");
    assert.match(result.message, /state changed|release changed|selected commit changed/);
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    assert.equal(f.host.reservations.size, 0);
  });
});

test("the final context check rejects transitions back to the original stale row state", async t => {
  for (const type of ["Issue", "PullRequest"]) await t.test(type, async t => {
    const issue = { state: "open" };
    const pull = { state: "open", merged: false };
    const endpoint = `/repos/example/widgets/${type === "Issue" ? "issues" : "pulls"}/1`;
    let queries = 0;
    const f = await fixture(t, { type, issue, pull, repositories: [], onExecute: name => {
      if (name === "list_sessions_and_chats" && ++queries === 3) {
        issue.state = "closed";
        pull.state = "closed";
        f.client.subjectCache.set(endpoint, { state: "closed" });
      }
    } });
    f.client.subjectCache.set(endpoint, { state: "closed" });
    assert.equal((await prepare(f)).action, type === "Issue" ? "issue" : "review");
    assert.equal((await start(f, { clone: true })).status, "error");
    assert.match(f.handoff.snapshot().message, /state changed/);
    assert.equal(f.requests.filter(args => args.at(-1) === endpoint).length, 3);
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
  });
});

test("the final context check fails closed and rechecks preferences after its request", async t => {
  for (const failure of ["unavailable", "disabled", "confirmations restored"]) await t.test(failure, async t => {
    const preferences = handoffPreferences(false);
    let reads = 0;
    const f = await fixture(t, { preferences, onGitHub: args => {
      if (args.at(-1) !== "/repos/example/widgets/issues/1" || ++reads !== 3) return;
      if (failure === "unavailable") return http({}, {}, 503);
      if (failure === "disabled") preferences.settings.copilotIntegration = false;
      else preferences.settings.confirmCopilotActions = true;
    } });
    f.handoff.request({ id: "1", direct: true });
    await f.handoff.pending;
    assert.equal(reads, 3);
    assert.equal(f.handoff.snapshot().status, "error");
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    assert.equal(f.host.reservations.size, 0);
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

test("restoring confirmations during the final inventory check prevents a direct creation", async t => {
  const preferences = handoffPreferences(false);
  let queries = 0;
  const f = await fixture(t, { preferences, onExecute: name => {
    if (name === "list_sessions_and_chats" && ++queries === 3) preferences.settings.confirmCopilotActions = true;
  } });
  f.handoff.request({ id: "1", direct: true });
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "error");
  assert.match(f.handoff.snapshot().message, /needs confirmation/);
  assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
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
