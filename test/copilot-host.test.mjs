import test from "node:test";
import assert from "node:assert/strict";
import { CopilotHost } from "../src/provider/copilot.mjs";
import { startServer } from "../src/provider/server.mjs";
import { copilotHost, projectId, sessionId, toolNames } from "./fixtures/copilot-host.mjs";
import { fixture, prepare, start, deferred, handoffPreferences } from "./fixtures/copilot-handoff.mjs";

test("discussion sessions reuse only the matching repository and generated discussion name, with an explicit choice", async t => {
  const f = await fixture(t, { type: "Discussion", preferences: handoffPreferences(false), sessions: [
    { type: "session", id: "33333333-3333-4333-8333-333333333333", project_repo: "example/widgets",
      name: "Work on PR #1", source_pr_number: 1, source_issue_number: 1 },
    { type: "session", id: "44444444-4444-4444-8444-444444444444", project_repo: "other/repo",
      name: "Summarize discussion #1" },
  ] });
  f.handoff.request({ id: "1", direct: true });
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "started");
  f.handoff.request({ id: "1", direct: true });
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "ready");
  assert.deepEqual(f.handoff.snapshot().sessions, [{ id: sessionId, name: "Summarize discussion #1" }]);
  assert.equal(f.calls.filter(call => call.name === "navigate_to").length, 1);
  assert.equal((await start(f, { sessionId })).status, "opened");
  assert.equal(f.calls.filter(call => call.name === "create_session").length, 1);
  assert.equal(f.calls.filter(call => call.name === "navigate_to").length, 2);
  assert.equal(f.calls.some(call => call.name === "send_session_message"), false);
});

test("closed issues retain native and generated-name session reuse without sending a fixing prompt", async t => {
  for (const linked of [true, false]) await t.test(String(linked), async t => {
    const session = { type: "session", id: sessionId, project_repo: "example/widgets",
      ...(linked ? { source_issue_number: 1, name: "Existing issue" } : { name: "Investigate issue #1" }) };
    const f = await fixture(t, { issue: { state: "closed" }, sessions: [{ ...session }] });
    assert.equal((await prepare(f)).sessions.length, 1);
    assert.equal((await start(f, { sessionId })).status, "opened");
    assert.deepEqual(f.sessions, [session]);
    assert.equal(f.calls.some(call => ["create_session", "send_session_message"].includes(call.name)), false);
  });
});

test("release summaries reuse only the same repository and release ID, never a native PR link", async t => {
  const unrelated = { type: "session", id: "33333333-3333-4333-8333-333333333333",
    project_repo: "example/widgets", name: "Work on PR #42", source_pr_number: 42 };
  const f = await fixture(t, { type: "Release", sessions: [unrelated], preferences: handoffPreferences(false) });
  assert.deepEqual((await prepare(f)).sessions, []);
  await start(f);
  f.handoff.request({ id: "1", direct: true });
  await f.handoff.pending;
  assert.deepEqual(f.handoff.snapshot().sessions, [{ id: sessionId, name: "Summarize release 42" }]);
  const before = structuredClone(f.sessions);
  assert.equal((await start(f, { sessionId })).status, "opened");
  assert.deepEqual(f.sessions, before);
  assert.equal(f.calls.filter(call => call.name === "create_session").length, 1);
  assert.equal(f.calls.some(call => call.name === "send_session_message"), false);
});

test("closed and merged summaries confirm existing-session reuse and navigate without instructions", async t => {
  for (const merged of [false, true]) for (const linked of [true, false]) await t.test(`${merged}/${linked}`, async t => {
    const session = { type: "session", id: sessionId, project_repo: "example/widgets",
      ...(linked ? { source_pr_number: 1, name: "Existing review" } : { name: "Work on PR #1" }) };
    const f = await fixture(t, { type: "PullRequest", pull: { state: "closed", merged },
      sessions: [{ ...session }], preferences: handoffPreferences(false) });
    f.handoff.request({ id: "1", direct: true });
    await f.handoff.pending;
    assert.equal(f.handoff.snapshot().label, "Summarize Changes");
    assert.equal(f.handoff.snapshot().status, "ready");
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    assert.equal((await start(f, { sessionId })).status, "opened");
    assert.deepEqual(f.sessions, [session]);
    assert.deepEqual(f.gitCalls, []);
    assert.equal(f.calls.some(call => ["create_session", "send_session_message"].includes(call.name)), false);
  });
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

test("an explicit fresh start leaves matching sessions untouched without inferring their health", async t => {
  const existing = { type: "session", id: sessionId, project_repo: "example/widgets",
    name: "Investigate issue #1", activity: { status: "unknown" } };
  const f = await fixture(t, { sessions: [existing], preferences: handoffPreferences(false) });
  const before = structuredClone(existing);
  f.handoff.request({ id: "1", direct: true });
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "ready");
  assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
  const ready = f.handoff.snapshot();
  assert.equal((await start(f, { startNew: true })).status, "started");
  assert.deepEqual(existing, before);
  assert.equal(f.sessions.length, 2);
  const created = f.sessions[1];
  assert.notEqual(created.id, existing.id);
  assert.equal(created.name, existing.name);
  assert.equal(created.parent_session_id, null);
  assert.deepEqual(f.calls.filter(call => !call.name.startsWith("list_")).map(call => call.name), ["create_session", "navigate_to"]);
  assert.equal(f.calls.at(-1).args.id, created.id);
  assert.throws(() => f.handoff.request({ id: "1", token: ready.token, startNew: true }), { code: "stale_handoff" });
  assert.equal((await prepare(f)).sessions.length, 2);
});

test("fresh starts require a matching-session token and separate cloning consent", async t => {
  const f = await fixture(t);
  for (const input of [{ id: "1", startNew: true }, { id: "1", direct: true, startNew: true },
    { id: "1", startNew: false }, { id: "1", token: "bad", startNew: true, sessionId }]) {
    assert.throws(() => f.handoff.request(input), { code: "invalid_handoff" });
  }
  const ready = await prepare(f);
  assert.throws(() => f.handoff.request({ id: "1", token: ready.token, startNew: true }), { code: "invalid_handoff" });
  const existing = { type: "session", id: sessionId, project_repo: "example/widgets", name: "Investigate issue #1" };
  const unconfigured = await fixture(t, { sessions: [existing], repositories: [] });
  assert.equal((await prepare(unconfigured)).needsClone, true);
  assert.equal((await start(unconfigured, { startNew: true })).status, "error");
  assert.equal(unconfigured.calls.some(call => call.name === "add_repository"), false);
  await prepare(unconfigured);
  assert.equal((await start(unconfigured, { startNew: true, clone: true })).status, "started");
  assert.equal(unconfigured.calls.filter(call => call.name === "add_repository").length, 1);
});

test("a fresh-start confirmation is renewed when matching sessions change before creation", async t => {
  for (const boundary of ["confirmation", "checkout"]) await t.test(boundary, async t => {
    const existing = { type: "session", id: sessionId, project_repo: "example/widgets", name: "Work on PR #1" };
    const concurrent = { ...existing, id: "33333333-3333-4333-8333-333333333333" };
    const f = await fixture(t, { type: "PullRequest", sessions: [existing] });
    const ready = await prepare(f);
    if (boundary === "confirmation") f.sessions.push(concurrent);
    else t.mock.method(f.host, "prepareCommit", async () => { f.sessions.push(concurrent); });
    assert.equal((await start(f, { startNew: true })).status, "ready");
    assert.notEqual(f.handoff.snapshot().token, ready.token);
    assert.equal(f.handoff.snapshot().sessions.length, 2);
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
  });
});

test("a session appearing during checkout requires a choice for normal and direct starts", async t => {
  for (const direct of [false, true]) await t.test(direct ? "direct" : "confirmed", async t => {
    const entered = deferred();
    const held = deferred();
    t.after(() => held.resolve());
    const f = await fixture(t, { type: "PullRequest", preferences: handoffPreferences(!direct) });
    t.mock.method(f.host, "prepareCommit", async () => {
      entered.resolve();
      await held.promise;
    });
    const original = direct ? undefined : await prepare(f);
    f.handoff.request({ id: "1", ...(direct ? { direct: true } : { token: original.token }) });
    await entered.promise;
    const existing = { type: "session", id: sessionId, project_repo: "example/widgets", name: "Work on PR #1" };
    f.sessions.push(existing);
    held.resolve();
    await f.handoff.pending;
    const ready = f.handoff.snapshot();
    assert.equal(ready.status, "ready");
    assert.notEqual(ready.token, original?.token);
    assert.deepEqual(ready.sessions, [{ id: sessionId, name: existing.name }]);
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    if (original) {
      assert.throws(() => f.handoff.request({ id: "1", token: original.token }), { code: "stale_handoff" });
    }
    assert.equal((await start(f, { sessionId })).status, "opened");
    assert.equal(f.sessions.length, 1);
    assert.equal(f.calls.some(call => call.name === "create_session"), false);
    assert.equal(f.host.reservations.size, 0);
  });
});

test("issue creation rechecks matching sessions after repository setup", async t => {
  const f = await fixture(t, { repositories: [], onExecute: name => {
    if (name === "add_repository") {
      f.sessions.push({ type: "session", id: sessionId, project_repo: "example/widgets", name: "Investigate issue #1" });
    }
  } });
  await prepare(f);
  const ready = await start(f, { clone: true });
  assert.equal(ready.status, "ready");
  assert.equal(ready.needsClone, false);
  assert.equal(ready.sessions.length, 1);
  assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
});

test("checkout, fetch, creation and navigation report progress without exposing targets", async t => {
  let present = false;
  const messages = [];
  const f = await fixture(t, { type: "PullRequest",
    onGit: args => {
      messages.push(f.handoff.snapshot().message);
      if (args.includes("--verify") && !present) throw Object.assign(new Error("Missing"), { code: 1 });
      if (args.includes("fetch")) present = true;
    },
    onExecute: name => {
      if (["create_session", "navigate_to"].includes(name)) messages.push(f.handoff.snapshot().message);
    },
  });
  await prepare(f);
  assert.equal((await start(f)).status, "started");
  assert.deepEqual([...new Set(messages)], [
    "Preparing checkout...", "Fetching selected commit...",
    "Starting session. Check the app for any permission or repository trust requests.", "Opening new session...",
  ]);
  assert.doesNotMatch(messages.join(" "), /example|Private title|[a-f0-9]{40}/);
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
  assert.equal(missing.initializing, false);
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

test("startup discovery keeps retrying empty, partial and failed metadata beyond the initial attempts", async () => {
  const logs = [];
  const f = copilotHost({ log: message => logs.push(message) });
  const metadata = await f.rpc.getCurrentMetadata();
  let now = 0;
  let calls = 0;
  f.host.now = () => now;
  f.rpc.getCurrentMetadata = async () => {
    calls++;
    if (calls === 1) return { tools: [] };
    if (calls === 2) return { tools: metadata.tools.filter(tool => tool.name !== "create_session") };
    if (calls === 3) throw new Error("Private host failure detail");
    if (calls <= 5) return { tools: [] };
    return metadata;
  };
  for (const [index, delay] of [1000, 2000, 5000, 5000, 5000].entries()) {
    const pending = f.host.refresh();
    assert.equal(f.host.refresh(), pending, "Concurrent panels share discovery");
    await pending;
    assert.equal(f.host.initializing, true);
    assert.equal(f.host.supports(), false);
    await assert.rejects(f.host.execute("create_session", {}), { code: "copilot_unavailable" });
    now += delay - 1;
    await f.host.refresh();
    assert.equal(calls, index + 1, "Polling must respect each retry deadline");
    now++;
  }
  await f.host.refresh();
  assert.equal(calls, 6);
  assert.equal(f.host.initializing, false);
  assert.equal(f.host.supports(), true);
  assert.deepEqual(logs, ["Could not discover Copilot session actions."]);
  now += 59_999;
  await f.host.refresh();
  assert.equal(calls, 6);
  now++;
  await f.host.refresh();
  assert.equal(calls, 7);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.gitCalls, []);
});

test("startup discovery still retries every five seconds after two minutes", async t => {
  const f = await fixture(t, { coldHost: true });
  const metadata = await f.rpc.getCurrentMetadata();
  let now = 0;
  let calls = 0;
  let supported = false;
  f.host.now = () => now;
  f.rpc.getCurrentMetadata = async () => {
    calls++;
    return supported ? metadata : { tools: null };
  };
  const item = f.inbox.loadedItems()[0];
  for (const time of [0, 1000, 3000]) {
    now = time;
    await f.host.refresh();
  }
  for (now = 8000; now <= 123_000; now += 5000) {
    await f.host.refresh();
    assert.equal(f.handoff.loading, true);
    assert.equal(f.handoff.row(item).enabled, false);
    assert.equal(f.host.nextCheckAt, now + 5000);
  }
  supported = true;
  const attempts = calls;
  now = 127_999;
  await f.host.refresh();
  assert.equal(calls, attempts);
  now++;
  await f.host.refresh();
  assert.equal(calls, attempts + 1);
  assert.equal(f.handoff.row(item).enabled, true);
  assert.equal(f.handoff.loading, false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.gitCalls, []);
});

test("unsupported hosts keep loading for three minutes, then show disabled controls and retain slow recovery", async t => {
  const f = await fixture(t, { coldHost: true });
  const metadata = await f.rpc.getCurrentMetadata();
  let now = 0;
  let calls = 0;
  let supported = false;
  f.host.now = () => now;
  f.rpc.getCurrentMetadata = async () => {
    calls++;
    return supported ? metadata : { tools: metadata.tools.filter(tool => tool.name !== "create_session") };
  };
  const item = f.inbox.loadedItems()[0];
  const checks = [0, 1000, 3000];
  for (let time = 8000; time < 180_000; time += 5000) checks.push(time);
  for (const time of checks) {
    now = time;
    assert.equal(f.handoff.loading, true);
    assert.deepEqual(f.handoff.row(item), {
      label: "Waiting on copilot SDK Availability", enabled: false, reason: "Waiting on copilot SDK Availability", loading: true,
    });
    await f.host.refresh();
  }
  now = 179_999;
  await f.host.refresh();
  assert.equal(calls, checks.length);
  assert.equal(f.handoff.loading, true);
  now++;
  await f.host.refresh();
  assert.equal(f.handoff.loading, false);
  const unavailable = {
    label: "Copilot tooling unavailable", enabled: false, reason: "Copilot tooling unavailable",
  };
  assert.deepEqual(f.handoff.row(item), unavailable);
  f.handoff.request({ id: item.id });
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "error");
  assert.equal(calls, checks.length + 1);
  supported = true;
  now = 239_999;
  await f.host.refresh();
  assert.deepEqual(f.handoff.row(item), unavailable);
  assert.equal(calls, checks.length + 1);
  now++;
  await f.host.refresh();
  assert.equal(f.handoff.row(item).enabled, true);
  assert.equal(f.handoff.loading, false);
  assert.equal(calls, checks.length + 2);
  assert.deepEqual(f.calls, []);
});

test("cold HTTP snapshots bound stalled discovery to three minutes and recover when it completes", async t => {
  const f = await fixture(t, { coldHost: true });
  let now = 0;
  f.host.now = () => now;
  const metadata = await f.rpc.getCurrentMetadata();
  const discovery = deferred();
  t.after(() => discovery.resolve(metadata));
  f.rpc.getCurrentMetadata = () => discovery.promise;
  f.client.subjectsNeedRefresh = () => false;
  const server = await startServer(f.inbox, { copilot: f.handoff, development: false });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin };
  const state = () => fetch(new URL("/api/state", url), { headers }).then(response => response.json());
  const initial = await state();
  assert.equal(initial.copilotLoading, true);
  assert.equal(initial.groups[0].items[0].copilot.enabled, false);
  assert.equal(initial.groups[0].items[0].copilot.loading, true);
  const queued = { ...f.inbox.loadedItems()[0], type: "PullRequest", subjectState: "merge_queued" };
  assert.equal(f.handoff.row(queued).label, "PR in merge queue");
  f.handoff.setEnabled(false);
  assert.equal((await state()).copilotLoading, false);
  assert.equal(f.handoff.row(queued), null);
  f.handoff.setEnabled(true);
  now = 179_999;
  assert.equal((await state()).copilotLoading, true);
  now++;
  const unavailable = await state();
  assert.equal(unavailable.copilotLoading, false);
  assert.deepEqual(unavailable.groups[0].items[0].copilot, {
    label: "Copilot tooling unavailable", enabled: false, reason: "Copilot tooling unavailable",
  });
  assert.equal(f.host.refresh(), f.host.pending, "A stalled discovery must not start overlapping requests");
  discovery.resolve(metadata);
  await f.handoff.hydrating;
  const ready = await state();
  assert.equal(ready.copilotLoading, false);
  assert.equal(ready.groups[0].items[0].copilot.enabled, true);
  assert.equal(Object.hasOwn(f.inbox.summary(), "copilotLoading"), false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.gitCalls, []);
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
    assert.deepEqual(f.handoff.row(f.inbox.loadedItems()[0]), {
      label: "Copilot tooling unavailable", enabled: false, reason: "Copilot tooling unavailable",
    });
    f.handoff.request({ id: "1" });
    await f.handoff.pending;
    assert.equal(f.handoff.snapshot().status, "error");
    await assert.rejects(f.host.execute("create_session", {}), { code: "copilot_unavailable" });
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
