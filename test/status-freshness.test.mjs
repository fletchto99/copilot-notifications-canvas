import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, RETRY_MS } from "../src/github.mjs";
import { normalizeThreads } from "../src/model.mjs";
import { http, thread } from "./fixtures.mjs";
import { renderer } from "./renderer-fixtures.mjs";

test("failed refreshes retain the last successful status and check time without bypassing backoff", async () => {
  let now = 1000;
  let calls = 0;
  const client = new GitHubClient({ now: () => now, run: async () => {
    calls++;
    return calls === 1 ? http({ state: "closed", merged: true, draft: false }, { etag: '"state"' }) :
      calls === 2 ? http({}, {}, 503) : http({ state: "closed", merged: false, draft: false });
  } });
  const [item] = normalizeThreads([thread()]);
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).subjectCheckedAt, 1000);
  now += 1000;
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).subjectCheckedAt, 1000);
  client.invalidateSubjects([item]);
  await client.refreshSubjects([item]);
  const stale = client.subjectSnapshot(item);
  assert.equal(stale.subjectState, "merged");
  assert.equal(stale.subjectCheckedAt, 1000);
  assert.equal(stale.subjectStateStale, true);
  assert.match(stale.subjectStateError, /503/);
  assert.equal(client.subjectsNeedRefresh([item]), false);
  client.invalidateSubjects([item]);
  await client.refreshSubjects([item]);
  assert.equal(calls, 2);
  now += RETRY_MS;
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).subjectState, "closed");
  assert.equal(client.subjectSnapshot(item).subjectCheckedAt, now);
  assert.equal(client.subjectSnapshot(item).subjectStateStale, false);
  assert.equal(client.subjectSnapshot(item).subjectStateError, null);
});

test("queue freshness reflects the oldest contributing check and failed queue refreshes retain membership", async () => {
  let now = 1000;
  let queueFails = false;
  const client = new GitHubClient({ now: () => now, run: async args => {
    if (args.at(-1) !== "graphql") return http({ state: "open", merged: false, draft: false });
    now += 1000;
    return queueFails ? http({}, {}, 403) : http({ data: { repository: { pullRequest: { isInMergeQueue: true } } } });
  } });
  const [item] = normalizeThreads([thread()]);
  const endpoint = "/repos/example/widgets/pulls/42";
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).subjectCheckedAt, 1000);
  now = 3000;
  client.subjectCache.get(endpoint).nextRefreshAt = 0;
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).subjectCheckedAt, 2000);
  queueFails = true;
  client.mergeQueueCache.get(endpoint).nextRefreshAt = 0;
  await client.refreshSubjects([item]);
  assert.equal(client.subjectSnapshot(item).subjectState, "merge_queued");
  assert.equal(client.subjectSnapshot(item).subjectCheckedAt, 2000);
  assert.equal(client.subjectSnapshot(item).subjectStateStale, true);
  assert.match(client.subjectSnapshot(item).subjectStateError, /merge queue/);
  assert.equal(client.subjectsNeedRefresh([item]), false);
});

test("screen-reader ages advance locally without restoring tooltips, recreating rows or making GitHub requests", async () => {
  const subjectStates = { 1: { subjectState: "merged", subjectCheckedAt: Date.now() - 120_000 } };
  const ui = await renderer({ initialRows: [thread()], subjectStates });
  try {
    const icon = ui.ids.get("groups").querySelectorAll(".subject-icon")[0];
    assert.equal(icon.attributes["aria-label"], "Pull Request: Merged. Checked 2 minutes ago");
    assert.equal(icon.title, undefined);
    const calls = ui.calls.length;
    ui.advance(60_000);
    await ui.fireTimer(15_000);
    assert.equal(icon.attributes["aria-label"], "Pull Request: Merged. Checked 3 minutes ago");
    assert.equal(icon.title, undefined);
    assert.equal(ui.calls.length, calls);
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-icon")[0], icon);
    subjectStates[1].subjectStateStale = true;
    subjectStates[1].subjectStateError = "Synthetic refresh failure.";
    await ui.fireTimer();
    const stale = ui.ids.get("groups").querySelectorAll(".subject-icon")[0];
    assert.match(stale.attributes["aria-label"], /^Pull Request: Merged\. Cached result; refresh failed\./);
    assert.match(stale.attributes["aria-label"], /Checked 3 minutes ago$/);
    assert.equal(stale.title, undefined);
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-loading").length, 0);
  } finally {
    ui.window.events.pagehide();
  }
});
