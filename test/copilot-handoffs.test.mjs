import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, RETRY_MS } from "../src/provider/github.mjs";
import { InboxError, normalizeThreads } from "../src/shared/model.mjs";
import { startServer } from "../src/provider/server.mjs";
import { thread, http } from "./fixtures.mjs";
import { projectId, sessionId } from "./fixtures/copilot-host.mjs";
import { sha, prSha, runDetails, releaseDetails, commitDetails, fixture, prepare, start, deferred, handoffPreferences } from "./fixtures/copilot-handoff.mjs";

test("issue and PR handoffs create root sessions in the target repository and summarize first without notification content", async t => {
  for (const [type, authorId, label] of [
    ["Issue", 8, "Investigate with Copilot"],
    ["PullRequest", 7, "Continue with Copilot"],
    ["PullRequest", 8, "Review with Copilot"],
  ]) await t.test(label, async t => {
    const f = await fixture(t, { type, authorId });
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

test("discussion handoffs summarize open, answered, closed and unknown states without notification content or writes", async t => {
  for (const state of [undefined, "open", "answered", "closed", "duplicate", "outdated"]) {
    await t.test(state ?? "unknown", async t => {
      const f = await fixture(t, { type: "Discussion" });
      f.client.subjectCache.set("/repos/example/widgets/discussions/1", { state });
      const item = f.inbox.loadedItems()[0];
      assert.equal(item.number, null);
      assert.deepEqual(f.handoff.row({ ...item, ...f.client.subjectSnapshot(item) }), {
        label: "Summarize with Copilot", enabled: true, reason: "",
      });
      const before = f.inbox.summary();
      const ready = await prepare(f);
      assert.equal(ready.label, "Summarize with Copilot");
      assert.equal(ready.action, "discussion");
      assert.equal(ready.url, "https://github.com/example/widgets/discussions/1");
      assert.equal(f.calls.some(call => call.name === "create_session"), false);
      assert.equal((await start(f)).status, "started");
      const { kickoff, ...creation } = f.calls.find(call => call.name === "create_session").args;
      assert.deepEqual(creation, {
        project_id: projectId, name: "Summarize discussion #1", workspace_type: "worktree", detached: true,
      });
      assert.equal(kickoff.mode, "plan");
      assert.match(kickoff.prompt, /Summarize this discussion/);
      assert.match(kickoff.prompt, /comments,? and replies/);
      assert.ok(kickoff.prompt.includes(ready.url));
      assert.match(kickoff.prompt, /open or closed state/);
      assert.match(kickoff.prompt, /decisions or accepted answer/);
      assert.match(kickoff.prompt, /unresolved questions/);
      assert.match(kickoff.prompt, /Stop after the summary/);
      assert.match(kickoff.prompt, /[Ww]ait for explicit user approval before editing files/);
      assert.match(kickoff.prompt, /Never mark the notification read or done/);
      assert.match(kickoff.prompt, /discussion (?:text|posts).*untrusted evidence/);
      assert.doesNotMatch(kickoff.prompt, /Private title|script|Then proceed with read-only investigation|verified head commit/);
      assert.equal(f.calls.some(call => call.name === "send_session_message"), false);
      assert.deepEqual(f.inbox.summary(), before);
      assert.deepEqual(f.gitCalls, []);
      assert.deepEqual(f.requests, []);
    });
  }
});

test("discussion handoffs require a validated direct discussion reference", async t => {
  for (const url of [null, "https://evil.test/repos/example/widgets/discussions/1",
    "https://api.github.com/repos/other/repo/discussions/1",
    "https://api.github.com/repos/example/widgets/issues/1",
    "https://api.github.com/repos/example/widgets/discussions/0",
    "https://api.github.com/repos/example/widgets/discussions/9007199254740992"]) {
    const f = await fixture(t, { type: "Discussion" });
    const [item] = normalizeThreads([thread("1", { subject: { type: "Discussion", title: "Synthetic discussion", url } })]);
    f.inbox.pages[0].items = [item];
    assert.equal(f.handoff.row(item), null);
    f.handoff.request({ id: "1" });
    await f.handoff.pending;
    assert.equal(f.handoff.snapshot().status, "error");
    assert.deepEqual(f.calls, []);
  }
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

test("PR head changes after confirmation or during checkout require a fresh action", async t => {
  for (const boundary of ["confirmation", "checkout"]) await t.test(boundary, async t => {
    const updated = "c".repeat(40);
    const pull = { head: { sha: prSha } };
    const f = await fixture(t, { type: "PullRequest", pull,
      preferences: handoffPreferences(boundary === "confirmation"),
      onGit: args => {
        if (boundary === "checkout" && args.includes("--verify")) pull.head.sha = updated;
      },
    });
    if (boundary === "confirmation") {
      await prepare(f);
      pull.head.sha = updated;
      await start(f);
      assert.deepEqual(f.gitCalls, []);
    } else {
      f.handoff.request({ id: "1", direct: true });
      await f.handoff.pending;
    }
    assert.equal(f.handoff.snapshot().status, "error");
    assert.match(f.handoff.snapshot().message, /head commit changed/);
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    assert.equal(f.host.reservations.size, 0);
    await prepare(f);
    assert.equal((await start(f)).status, "started");
    assert.equal(f.calls.find(call => call.name === "create_session").args.base_branch, updated);
  });
});

test("PR changes during the final queue request cannot authorize a stale session", async t => {
  for (const change of ["head", "closed", "merged"]) await t.test(change, async t => {
    const entered = deferred();
    const held = deferred();
    t.after(() => held.resolve());
    const pull = { state: "open", merged: false, head: { sha: prSha } };
    const f = await fixture(t, { type: "PullRequest", pull, onGitHub: async args => {
      if (args.at(-1) !== "graphql") return;
      if (f.calls.filter(call => call.name === "list_sessions_and_chats").length === 3) {
        entered.resolve();
        await held.promise;
      }
      return http({ data: { repository: { pullRequest: {
        isInMergeQueue: false, state: pull.merged ? "MERGED" : pull.state.toUpperCase(), headRefOid: pull.head.sha,
      } } } });
    } });
    await prepare(f);
    const starting = start(f);
    await entered.promise;
    if (change === "head") pull.head.sha = "c".repeat(40);
    else Object.assign(pull, { state: "closed", merged: change === "merged" });
    held.resolve();
    const result = await starting;
    assert.equal(result.status, "error");
    assert.match(result.message, change === "head" ? /head commit changed/ : /state changed/);
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    assert.equal(f.host.reservations.size, 0);
  });
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

test("closed issue actions summarize outcomes instead of proposing fixes for every closure reason", async t => {
  for (const reason of ["completed", "not_planned", "duplicate"]) for (const direct of [false, true]) {
    await t.test(`${reason}/${direct}`, async t => {
      const f = await fixture(t, { issue: { state: "closed", state_reason: reason, body: "Private issue body" },
        preferences: handoffPreferences(!direct) });
      f.client.subjectCache.set("/repos/example/widgets/issues/1", { state: reason === "completed" ? "closed" : reason });
      const item = f.inbox.loadedItems()[0];
      assert.deepEqual(f.handoff.row({ ...item, ...f.client.subjectSnapshot(item) }),
        { label: "Summarize with Copilot", enabled: true, reason: "" });
      const before = f.inbox.summary();
      if (direct) {
        f.handoff.request({ id: "1", direct: true });
        await f.handoff.pending;
      } else {
        assert.equal((await prepare(f)).action, "issueSummary");
        assert.equal(f.calls.some(call => call.name === "create_session"), false);
        await start(f);
      }
      assert.equal(f.handoff.snapshot().status, "started", f.handoff.snapshot().message);
      const creation = f.calls.find(call => call.name === "create_session").args;
      assert.equal(creation.kickoff.mode, "plan");
      assert.equal(creation.base_branch, undefined);
      assert.match(creation.kickoff.prompt, /Summarize this closed issue read-only/);
      assert.match(creation.kickoff.prompt, /Do not assume closure means the issue was fixed/);
      assert.match(creation.kickoff.prompt, /Do not propose a fix, reopen the issue, or start implementation/);
      assert.match(creation.kickoff.prompt, /Stop after the summary/);
      assert.doesNotMatch(creation.kickoff.prompt, /Investigate this issue|ask_user|Propose implementation separately|Private/);
      assert.deepEqual(f.inbox.summary(), before);
      assert.deepEqual(f.gitCalls, []);
      assert.ok(f.requests.every(args => args.includes("GET")));
    });
  }
});

test("issue state changes invalidate the old task while fresh metadata overrides stale row state", async t => {
  for (const initial of ["open", "closed"]) await t.test(initial, async t => {
    const issue = { state: initial };
    const f = await fixture(t, { issue });
    f.client.subjectCache.set("/repos/example/widgets/issues/1", { state: initial });
    await prepare(f);
    issue.state = initial === "open" ? "closed" : "open";
    assert.equal((await start(f)).status, "error");
    assert.match(f.handoff.snapshot().message, /issue's state changed/);
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    assert.equal((await prepare(f)).action, initial === "open" ? "issueSummary" : "issue");
    assert.equal((await start(f)).status, "started");
  });
});

test("discussion actions summarize the selected thread regardless of its state and do not match PR or issue sessions", async t => {
  for (const state of ["open", "answered", "closed"]) await t.test(state, async t => {
    const f = await fixture(t, { type: "Discussion", sessions: [{
      type: "session", id: "33333333-3333-4333-8333-333333333333",
      project_repo: "example/widgets", name: "Unrelated work", source_issue_number: 1, source_pr_number: 1,
    }] });
    const item = f.inbox.loadedItems()[0];
    assert.equal(f.handoff.row({ ...item, subjectState: state }).label, "Summarize with Copilot");
    const before = f.inbox.summary();
    const ready = await prepare(f);
    assert.equal(ready.url, "https://github.com/example/widgets/discussions/1");
    assert.deepEqual(ready.sessions, []);
    assert.equal((await start(f)).status, "started");
    const creation = f.calls.find(call => call.name === "create_session").args;
    assert.equal(creation.name, "Summarize discussion #1");
    assert.equal(creation.kickoff.mode, "plan");
    assert.equal(creation.base_branch, undefined);
    assert.match(creation.kickoff.prompt, /Summarize this discussion read-only/);
    assert.match(creation.kickoff.prompt, /original post, comments, and replies/);
    assert.match(creation.kickoff.prompt, /accepted answer if present, and unresolved questions/);
    assert.match(creation.kickoff.prompt, /Stop after the summary/);
    assert.doesNotMatch(creation.kickoff.prompt, /Investigate this issue|Continue work|ask_user|Private/);
    assert.deepEqual(f.inbox.summary(), before);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.gitCalls, []);
    assert.equal((await prepare(f)).sessions.length, 1);
    assert.equal((await start(f, { sessionId })).status, "opened");
  });
});

test("commit summaries resolve full SHAs, prepare the exact checkout, and reuse the same commit across short references", async t => {
  const names = new Set();
  for (const commitRef of [sha, sha.slice(0, 9), sha.toUpperCase()]) await t.test(commitRef, async t => {
    let fetched = false;
    const f = await fixture(t, { type: "Commit", commitRef, onGit: args => {
      if (args.includes("fetch")) {
        assert.equal(args.at(-1), sha);
        fetched = true;
      }
      if (args.includes("--verify") && !fetched) throw Object.assign(new Error("Missing synthetic commit"), { code: 1 });
    } });
    assert.equal(f.handoff.row(f.inbox.loadedItems()[0]).label, "Summarize commit");
    const before = f.inbox.summary();
    const ready = await prepare(f);
    assert.equal(ready.url, commitDetails.html_url);
    assert.deepEqual(f.gitCalls, []);
    assert.equal((await start(f)).status, "started");
    const creation = f.calls.find(call => call.name === "create_session").args;
    names.add(creation.name);
    assert.ok(creation.name.length <= 40);
    assert.equal(creation.base_branch, sha);
    assert.equal(creation.kickoff.mode, "plan");
    assert.equal(creation.detached, true);
    assert.match(creation.kickoff.prompt, /Summarize the code changed in this commit read-only/);
    assert.match(creation.kickoff.prompt, /actual diff and relevant code context, not just the commit message/);
    assert.ok(creation.kickoff.prompt.includes(`verified commit ${sha}`));
    assert.match(creation.kickoff.prompt, /Stop after the summary/);
    assert.doesNotMatch(creation.kickoff.prompt, /pull request's verified head|ask_user|Private/);
    assert.doesNotMatch(JSON.stringify([...f.client.copilotCache]), /Private/);
    assert.deepEqual(f.inbox.summary(), before);
    assert.ok(f.requests.every(args => args.includes("GET")));
    assert.equal((await prepare(f)).sessions.length, 1);
    assert.equal((await start(f, { sessionId })).status, "opened");
    assert.equal(f.calls.filter(call => call.name === "create_session").length, 1);
  });
  assert.equal(names.size, 1);
});

test("commit context rejects unsafe references, unrelated or malformed SHAs, and foreign destinations", async t => {
  const f = await fixture(t, { type: "Commit" });
  const item = f.inbox.loadedItems()[0];
  for (const change of [{ sha: "main" }, { sha: prSha }, { sha: sha.slice(0, 12) },
    { html_url: "https://evil.test" }, { html_url: `https://github.com/other/widgets/commit/${sha}` }]) {
    const client = new GitHubClient({ run: async () => http({ ...commitDetails, ...change }) });
    await assert.rejects(client.copilotContext("commit", item), { code: "copilot_context" });
  }
  for (const change of [{ commitRef: "main" }, { commitRef: "a".repeat(64) }, { repository: "../widgets" },
    { commitRef: `${sha}?ref=main` }, { type: "Issue" }]) {
    const client = new GitHubClient({ run: () => assert.fail("Invalid references cannot run GitHub requests") });
    assert.throws(() => client.copilotContext("commit", { ...item, ...change }), { code: "copilot_context" });
  }
  for (const type of ["Commit", "Discussion"]) {
    assert.equal(f.handoff.row({ ...item, type, direct: false }), null);
  }
});

test("a short commit reference resolving differently after confirmation cannot start a session", async t => {
  const commit = { ...commitDetails };
  const f = await fixture(t, { type: "Commit", commitRef: sha.slice(0, 9), commit });
  await prepare(f);
  commit.sha = sha.slice(0, 9) + "b".repeat(31);
  commit.html_url = `https://github.com/example/widgets/commit/${commit.sha}`;
  assert.equal((await start(f)).status, "error");
  assert.match(f.handoff.snapshot().message, /selected commit changed/);
  assert.deepEqual(f.gitCalls, []);
  assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
});

test("release summaries bind the exact release and leave notes out of handoff data and notification state", async t => {
  for (const direct of [false, true]) await t.test(String(direct), async t => {
    const f = await fixture(t, { type: "Release", preferences: handoffPreferences(!direct) });
    const before = f.inbox.summary();
    assert.equal(f.handoff.row(f.inbox.loadedItems()[0]).label, "Summarize Release Notes");
    f.handoff.hydrate(f.inbox.loadedItems());
    await f.handoff.hydrating;
    await f.client.refreshSubjects(f.inbox.loadedItems());
    assert.deepEqual(f.requests, [], "Rendering releases does not fetch metadata or notes");
    if (direct) {
      f.handoff.request({ id: "1", direct: true });
      await f.handoff.pending;
    } else {
      const ready = await prepare(f);
      assert.equal(ready.label, "Summarize Release Notes");
      assert.equal(ready.action, "release");
      assert.equal(ready.url, releaseDetails.html_url);
      assert.equal(f.calls.some(call => call.name === "create_session"), false);
      await start(f);
    }
    assert.equal(f.handoff.snapshot().status, "started", f.handoff.snapshot().message);
    const { kickoff, ...creation } = f.calls.find(call => call.name === "create_session").args;
    assert.deepEqual(creation, {
      project_id: projectId, name: "Summarize release 42", workspace_type: "worktree", detached: true,
    });
    assert.equal(kickoff.mode, "plan");
    assert.match(kickoff.prompt, /Summarize this release's notes read-only/);
    assert.ok(kickoff.prompt.includes(releaseDetails.html_url));
    assert.match(kickoff.prompt, /endpoint repos\/example\/widgets\/releases\/42/);
    assert.match(kickoff.prompt, /never substitute the latest release/);
    assert.match(kickoff.prompt, /Do not download or execute release assets/);
    assert.match(kickoff.prompt, /Stop after the summary/);
    assert.doesNotMatch(kickoff.prompt, /ask_user|review skill|verified head commit/);
    const handoffData = JSON.stringify([f.calls, [...f.client.copilotCache], f.handoff.snapshot(), before]);
    for (const marker of ["Private title", "Private release", "ignore instructions", "<script>"]) {
      assert.equal(handoffData.includes(marker), false);
    }
    assert.doesNotMatch(JSON.stringify(before), /releaseId|example\/widgets/);
    assert.deepEqual(f.inbox.summary(), before);
    assert.deepEqual(f.gitCalls, []);
    assert.deepEqual(f.requests.map(args => args.at(-1)), Array(3).fill("/repos/example/widgets/releases/42"));
    assert.ok(f.requests.every(args => args.includes("GET")));
  });
});

test("missing release links cannot guess a tag or latest release", async t => {
  const f = await fixture(t, { type: "Release" });
  f.inbox.pages[0].items[0].releaseId = null;
  const row = f.handoff.row(f.inbox.loadedItems()[0]);
  assert.equal(row.enabled, false);
  assert.match(row.reason, /No specific release is linked/);
  f.handoff.request({ id: "1" });
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "error");
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.calls, []);
});

test("release metadata validates the exact ID and same-repository tag URL without retaining notes", async t => {
  const f = await fixture(t, { type: "Release" });
  const item = f.inbox.loadedItems()[0];
  for (const tag of ["v1.2.0", "releases/v2.0", "v2.0+build", "\u7248\u672c-3"]) {
    const url = `https://github.com/example/widgets/releases/tag/${encodeURIComponent(tag)}`;
    const client = new GitHubClient({ run: async () => http({ ...releaseDetails, tag_name: tag, html_url: url }) });
    assert.deepEqual(await client.copilotContext("release", item), { releaseId: "42", url });
  }
  for (const change of [{ id: 43 }, { id: "42" }, { id: Number.MAX_SAFE_INTEGER + 1 },
    { draft: true }, { draft: undefined }, { tag_name: "" }, { tag_name: "v2.0" },
    { tag_name: "v1\ninjection" }, { html_url: null }, { html_url: "not a URL" },
    ...["https://evil.test/example/widgets/releases/tag/v1.2.0",
      "https://github.com/other/widgets/releases/tag/v1.2.0",
      "https://secret@github.com/example/widgets/releases/tag/v1.2.0",
      "https://github.com/example/widgets/releases/latest",
      `${releaseDetails.html_url}?next=evil`, `${releaseDetails.html_url}#notes`,
      "https://github.com/example/widgets/releases/tag/%ZZ"]
      .map(html_url => ({ html_url }))]) {
    const client = new GitHubClient({ run: async () => http({ ...releaseDetails, ...change }) });
    await assert.rejects(client.copilotContext("release", item), { code: "copilot_context" });
  }
  for (const change of [{ releaseId: null }, { releaseId: "latest" }, { releaseId: "9007199254740993" },
    { repository: "../widgets" }, { releaseId: "42?next=1" }, { type: "Issue" }]) {
    const client = new GitHubClient({ run: () => assert.fail("Invalid references cannot make a request") });
    assert.throws(() => client.copilotContext("release", { ...item, ...change }), { code: "copilot_context" });
  }
});

test("deleted, draft, or retagged releases cannot use an earlier confirmation", async t => {
  for (const change of ["deleted", "draft", "retagged"]) await t.test(change, async t => {
    let starting = false;
    const f = await fixture(t, { type: "Release", onGitHub: args => {
      if (!starting || args.at(-1) !== "/repos/example/widgets/releases/42") return;
      return change === "deleted" ? http({}, {}, 404) : http({ ...releaseDetails,
        ...(change === "draft" ? { draft: true } : {
          tag_name: "v2.0", html_url: "https://github.com/example/widgets/releases/tag/v2.0",
        }),
      });
    } });
    await prepare(f);
    starting = true;
    assert.equal((await start(f)).status, "error");
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    assert.deepEqual(f.gitCalls, []);
  });
});

test("closed and merged PRs offer read-only summaries, with reopening help only for unmerged PRs", async t => {
  for (const merged of [false, true]) for (const authorId of [7, 8]) for (const direct of [false, true]) await t.test(`${merged}/${authorId}/${direct}`, async t => {
    const f = await fixture(t, { type: "PullRequest", authorId, pull: { state: "closed", merged },
      preferences: handoffPreferences(!direct),
      onGitHub: args => {
        assert.notEqual(args.at(-1), "graphql", "Closed and merged summaries do not need merge-queue membership");
      },
    });
    f.client.subjectCache.set("/repos/example/widgets/pulls/1", { state: merged ? "merged" : "closed" });
    const item = { ...f.inbox.loadedItems()[0], ...f.client.subjectSnapshot(f.inbox.loadedItems()[0]) };
    for (const viewerIsAuthor of [undefined, true, false]) {
      assert.deepEqual(f.handoff.row({ ...item, viewerIsAuthor }),
        { label: "Summarize Changes", enabled: true, reason: "" });
    }
    const before = f.inbox.summary();
    assert.deepEqual(f.calls, []);
    if (direct) {
      f.handoff.request({ id: "1", direct: true });
      await f.handoff.pending;
    } else {
      const ready = await prepare(f);
      assert.equal(ready.label, "Summarize Changes");
      assert.equal(ready.action, "summarize");
      assert.equal(ready.pullState, merged ? "merged" : "closed");
      assert.equal(f.calls.some(call => call.name === "create_session"), false);
      await start(f);
    }
    assert.equal(f.handoff.snapshot().status, "started", f.handoff.snapshot().message);
    const creation = f.calls.find(call => call.name === "create_session").args;
    assert.equal(creation.base_branch, prSha);
    assert.equal(creation.detached, true);
    assert.equal(creation.kickoff.mode, "plan");
    assert.match(creation.kickoff.prompt, new RegExp(`Summarize what this ${merged ? "merged" : "closed, unmerged"} pull request changed`));
    assert.match(creation.kickoff.prompt, /Read its diff, relevant repository context, and discussion/);
    if (merged) {
      assert.match(creation.kickoff.prompt, /Stop after the summary/);
      assert.doesNotMatch(creation.kickoff.prompt, /After the summary, use ask_user|reopen/);
    } else {
      assert.match(creation.kickoff.prompt, /proposed changes, not merged changes/);
      assert.match(creation.kickoff.prompt, /After the summary, use ask_user to ask whether the user would like help reopening/);
      assert.match(creation.kickoff.prompt, /"Help me reopen the PR" and "Keep it closed"/);
      assert.match(creation.kickoff.prompt, /Wait for the user's answer/);
      assert.match(creation.kickoff.prompt, /Do not reopen the PR, restore a branch, or make other changes without explicit approval/);
      assert.match(creation.kickoff.prompt, /If they decline, stop/);
      assert.doesNotMatch(creation.kickoff.prompt, /Stop after the summary|ask whether the user wants an available PR-review skill/);
    }
    assert.match(creation.kickoff.prompt, /Wait for explicit user approval before editing files/);
    for (const marker of ["Then proceed with read-only investigation", "Private title", "<script>"]) {
      assert.equal(creation.kickoff.prompt.includes(marker), false);
    }
    assert.deepEqual(f.inbox.summary(), before);
    assert.ok(f.requests.every(args => args.includes("GET")));
    assert.equal(f.calls.some(call => call.name === "send_session_message"), false);
  });
});

test("closed and merged summaries skip unavailable queue checks when cached PR state is missing or stale", async t => {
  for (const merged of [false, true]) for (const cachedState of [undefined, "open"]) for (const blocked of [false, true]) {
    await t.test(`${merged ? "merged" : "closed"}/${cachedState ?? "missing"}/${blocked ? "rate limited" : "unavailable"}`, async t => {
      const f = await fixture(t, { type: "PullRequest", pull: { state: "closed", merged },
        onGitHub: args => args.at(-1) === "graphql" ? http({}, {}, 403) : undefined,
      });
      if (cachedState) f.client.subjectCache.set("/repos/example/widgets/pulls/1", { state: cachedState });
      if (blocked) f.client.graphqlBlockedUntil = f.client.now() + RETRY_MS;
      const ready = await prepare(f);
      assert.equal(ready.action, "summarize");
      assert.equal(ready.pullState, merged ? "merged" : "closed");
      assert.equal(f.calls.some(call => call.name === "create_session"), false);
      assert.equal((await start(f)).status, "started");
      assert.ok(f.requests.some(args => args.at(-1) === "/repos/example/widgets/pulls/1"));
      assert.equal(f.requests.some(args => args.at(-1) === "graphql"), false);
    });
  }
});

test("fresh open and draft PR metadata precedes queue verification without weakening the queue guard", async t => {
  for (const draft of [false, true]) for (const queue of ["clear", "queued", "unavailable", "rate limited"]) {
    await t.test(`${draft ? "draft" : "open"}/${queue}`, async t => {
      const f = await fixture(t, { type: "PullRequest", pull: { draft }, onGitHub: args => {
        if (args.at(-1) !== "graphql") return;
        if (queue === "unavailable") return http({}, {}, 403);
        return http({ data: { repository: { pullRequest: { isInMergeQueue: queue === "queued" } } } });
      } });
      if (queue === "rate limited") f.client.graphqlBlockedUntil = f.client.now() + RETRY_MS;
      f.handoff.request({ id: "1" });
      await f.handoff.pending;
      const pullIndex = f.requests.findIndex(args => args.at(-1) === "/repos/example/widgets/pulls/1");
      const queueIndex = f.requests.findIndex(args => args.at(-1) === "graphql");
      assert.ok(pullIndex >= 0, "Fresh PR metadata must be read even when GraphQL is unavailable");
      if (queue === "rate limited") assert.equal(queueIndex, -1);
      else assert.ok(queueIndex > pullIndex, "Queue verification must follow the fresh PR state");
      assert.equal(f.handoff.snapshot().status, queue === "clear" ? "ready" : "error");
      if (queue === "queued") assert.match(f.handoff.snapshot().message, /merge-queued/);
      assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    });
  }
});

test("PR state changes cannot reuse confirmation for a different task", async t => {
  const states = ["open", "closed", "merged"];
  for (const initial of states) for (const next of states.filter(state => state !== initial)) await t.test(`${initial} to ${next}`, async t => {
    const pull = { state: initial === "open" ? "open" : "closed", merged: initial === "merged" };
    const f = await fixture(t, { type: "PullRequest", pull });
    f.client.subjectCache.set("/repos/example/widgets/pulls/1", { state: initial });
    await prepare(f);
    Object.assign(pull, { state: next === "open" ? "open" : "closed", merged: next === "merged" });
    assert.equal((await start(f)).status, "error");
    assert.match(f.handoff.snapshot().message, /state changed/);
    assert.deepEqual(f.gitCalls, []);
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    const ready = await prepare(f);
    assert.equal(ready.label, next === "open" ? "Review with Copilot" : "Summarize Changes");
    assert.equal(ready.pullState, next);
    assert.equal((await start(f)).status, "started");
  });
});

test("merge-queued PR actions are disabled and cannot use an earlier confirmation", async t => {
  const f = await fixture(t, { type: "PullRequest" });
  const ready = await prepare(f);
  const path = "/repos/example/widgets/pulls/1";
  f.client.subjectCache.set(path, { state: "open" });
  f.client.mergeQueueCache.set(path, { state: true });
  const item = f.inbox.loadedItems()[0];
  assert.deepEqual(f.handoff.row({ ...item, ...f.client.subjectSnapshot(item) }),
    { label: "PR in merge queue", enabled: false, reason: "PR in merge queue" });
  assert.throws(() => f.handoff.request({ id: "1", token: ready.token }), { code: "copilot_inactive_pr" });
  assert.equal(f.calls.some(call => call.name === "create_session"), false);
});

test("PRs entering the merge queue after confirmation, checkout, or discovery cannot start", async t => {
  for (const boundary of ["confirmation", "checkout", "discovery"]) await t.test(boundary, async t => {
    let queued = false;
    let queries = 0;
    const f = await fixture(t, { type: "PullRequest",
      preferences: handoffPreferences(boundary === "confirmation"),
      onGitHub: args => {
        if (args.at(-1) === "graphql") {
          return http({ data: { repository: { pullRequest: {
            isInMergeQueue: queued, state: "OPEN", headRefOid: prSha,
          } } } });
        }
      },
      onGit: args => {
        if (boundary === "checkout" && args.includes("--verify")) queued = true;
      },
      onExecute: name => {
        if (name === "list_sessions_and_chats" && ++queries === 3 && boundary === "discovery") queued = true;
      },
    });
    if (boundary === "confirmation") {
      await prepare(f);
      queued = true;
      await start(f);
      assert.deepEqual(f.gitCalls, []);
    } else {
      f.handoff.request({ id: "1", direct: true });
      await f.handoff.pending;
    }
    assert.equal(queued, true);
    assert.equal(f.handoff.snapshot().status, "error");
    assert.match(f.handoff.snapshot().message, /merge-queued/);
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    assert.equal(f.host.reservations.size, 0);
  });
});

test("PRs entering the merge queue during setup or checkout inspection never fetch", async t => {
  for (const boundary of ["setup", "inspection"]) await t.test(boundary, async t => {
    let queued = false;
    let present = false;
    const f = await fixture(t, { type: "PullRequest",
      ...(boundary === "setup" ? { repositories: [] } : {}),
      onExecute: name => {
        if (name === "add_repository") queued = true;
      },
      onGitHub: args => {
        if (args.at(-1) === "graphql") return http({ data: { repository: { pullRequest: {
          isInMergeQueue: queued, state: "OPEN", headRefOid: prSha,
        } } } });
      },
      onGit: args => {
        if (args.includes("--verify") && !present) {
          if (boundary === "inspection") queued = true;
          throw Object.assign(new Error("Missing synthetic commit"), { code: 1 });
        }
        if (args.includes("fetch")) present = true;
      },
    });
    await prepare(f);
    const result = await start(f, boundary === "setup" ? { clone: true } : {});
    assert.equal(queued, true);
    assert.equal(f.gitCalls.some(call => call.args.includes("fetch")), false);
    if (boundary === "setup") assert.deepEqual(f.gitCalls, []);
    assert.equal(result.status, "error");
    assert.match(result.message, /merge-queued/);
    assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    assert.equal(f.host.reservations.size, 0);
  });
});

test("a PR that changes state during checkout cannot start a stale task", async t => {
  for (const [initial, next] of [["open", "merged"], ["open", "closed"], ["closed", "open"], ["closed", "merged"]]) {
    await t.test(`${initial} to ${next}`, async t => {
      const f = await fixture(t, { type: "PullRequest", pull: { state: initial }, onGit: args => {
        if (args.includes("--verify")) {
          f.client.subjectCache.set("/repos/example/widgets/pulls/1", { state: next });
        }
      } });
      f.client.subjectCache.set("/repos/example/widgets/pulls/1", { state: initial });
      await prepare(f);
      assert.equal((await start(f)).status, "error");
      assert.match(f.handoff.snapshot().message, /state changed/);
      assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
    });
  }
});

test("a reopened PR with a stale closed snapshot still requires verified merge-queue status", async t => {
  const f = await fixture(t, { type: "PullRequest", onGitHub: args => {
    if (args.at(-1) === "graphql") return http({ data: { repository: { pullRequest: { isInMergeQueue: true } } } });
  } });
  f.client.subjectCache.set("/repos/example/widgets/pulls/1", { state: "closed" });
  f.handoff.request({ id: "1" });
  await f.handoff.pending;
  assert.equal(f.handoff.snapshot().status, "error");
  assert.match(f.handoff.snapshot().message, /merge-queued/);
  assert.equal(f.requests.filter(args => args.at(-1) === "graphql").length, 1);
  assert.equal(f.calls.some(call => ["create_session", "navigate_to"].includes(call.name)), false);
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

test("PR confirmations recheck warm queue results without bypassing failure or rate-limit backoff", async t => {
  for (const blocked of [false, true]) await t.test(blocked ? "rate limited" : "lookup failure", async t => {
    let checks = 0;
    const f = await fixture(t, { type: "PullRequest", onGitHub: args => {
      if (args.at(-1) === "graphql" && ++checks > 1) return http({}, {}, 403);
    } });
    await prepare(f);
    if (blocked) f.client.graphqlBlockedUntil = f.client.now() + RETRY_MS;
    assert.equal((await start(f)).status, "error");
    assert.equal(f.calls.some(call => call.name === "create_session"), false);
    assert.equal(checks, blocked ? 1 : 2);
    f.handoff.request({ id: "1" });
    await f.handoff.pending;
    assert.equal(f.handoff.snapshot().status, "error");
    assert.equal(checks, blocked ? 1 : 2, "A fresh action must still respect the failed queue lookup's backoff");
  });
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
