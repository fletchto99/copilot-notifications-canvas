import test from "node:test";
import assert from "node:assert/strict";
import { http, inboxNext as next, thread } from "./fixtures.mjs";
import { finishRows, renderer, settle } from "./renderer-fixtures.mjs";

const rows = count => Array.from({ length: count }, (_, index) => thread(String(1000000000000 + index)));
const selectionCalls = ui => ui.calls.filter(call => call.path === "/api/subjects").map(call => JSON.parse(call.options.body));
const sync = async ui => { ui.fireAnimationFrame(); await settle(); };

test("large expanded inboxes upload bounded positions without attaching IDs to ordinary requests", async () => {
  const initialRows = rows(650);
  const ui = await renderer({ initialRows });
  try {
    await sync(ui);
    const chunks = selectionCalls(ui);
    assert.equal(chunks.length, 7);
    assert.deepEqual(chunks.map(chunk => chunk.positions.length), [100, 100, 100, 100, 100, 100, 50]);
    assert.deepEqual(chunks.map(chunk => chunk.offset), [0, 100, 200, 300, 400, 500, 600]);
    assert.ok(chunks.slice(0, -1).every(chunk => !chunk.complete));
    assert.equal(chunks.at(-1).complete, true);
    assert.deepEqual(ui.subjectSelections.at(-1), initialRows.map(row => row.id));
    assert.ok(ui.calls.every(call => !Object.hasOwn(call.options.headers, "X-Notification-Visible-Ids")));
    assert.equal(ui.ids.get("notice").hidden, true);
    await ui.ids.get("force-refresh").events.click();
    await ui.ids.get("groups").querySelectorAll(".mark-read")[0].events.click();
    await ui.ids.get("groups").querySelectorAll(".mark-done")[1].events.click();
    assert.deepEqual(ui.patches, [`/notifications/threads/${initialRows[0].id}`]);
    assert.deepEqual(ui.deletions, [`/notifications/threads/${initialRows[1].id}`]);
    assert.equal(ui.ids.get("notice").hidden, true);
  } finally {
    ui.window.events.pagehide();
    ui.inbox.close();
  }
});

test("a slow status upload does not hold refresh, read, done or search requests", async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const initialRows = rows(250);
  const ui = await renderer({ initialRows, onSubjects: async () => held });
  try {
    ui.fireAnimationFrame();
    await settle();
    assert.equal(selectionCalls(ui).length, 1);
    await ui.ids.get("force-refresh").events.click();
    await ui.ids.get("groups").querySelectorAll(".mark-read")[0].events.click();
    await ui.ids.get("groups").querySelectorAll(".mark-done")[1].events.click();
    ui.ids.get("search").value = "not in loaded rows";
    ui.ids.get("search").events.input({});
    await ui.fireTimer(250);
    assert.equal(ui.ids.get("groups").querySelectorAll(".row-link").length, 0);
    assert.equal(ui.patches.length, 1);
    assert.equal(ui.deletions.length, 1);
    release();
    await settle();
    await sync(ui);
    assert.deepEqual(ui.subjectSelections.at(-1), []);
    assert.equal(selectionCalls(ui).length, 2, "Obsolete chunks were not sent after the first held request");
  } finally {
    release();
    ui.window.events.pagehide();
    ui.inbox.close();
  }
});

test("collapse during an upload discards remaining chunks and expands again with a newer version", async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let hold = true;
  const initialRows = rows(250);
  const ui = await renderer({ initialRows, onSubjects: async () => { if (hold) await held; } });
  try {
    await sync(ui);
    ui.ids.get("collapse").events.click();
    hold = false;
    release();
    await settle();
    await sync(ui);
    assert.deepEqual(ui.subjectSelections.at(-1), []);
    assert.deepEqual(selectionCalls(ui).map(chunk => chunk.version), [1, 2]);
    ui.ids.get("collapse").events.click();
    await sync(ui);
    assert.deepEqual(ui.subjectSelections.at(-1), initialRows.map(row => row.id));
    assert.deepEqual(selectionCalls(ui).slice(2).map(chunk => chunk.version), [3, 3, 3]);
  } finally {
    release();
    ui.window.events.pagehide();
    ui.inbox.close();
  }
});

test("status upload failures are explicit, retry on polling, and never block ordinary actions", async () => {
  for (const failure of [new Error("Synthetic selection failure"), Object.assign(new Error(), { name: "AbortError" })]) {
    let fail = true;
    const initialRows = rows(250);
    const ui = await renderer({ initialRows, onSubjects: async () => { if (fail) throw failure; } });
    try {
      await sync(ui);
      assert.match(ui.ids.get("notice").textContent, /Notification status loading paused/);
      assert.match(ui.ids.get("notice").textContent, /Retrying automatically/);
      assert.doesNotMatch(ui.ids.get("notice").textContent, /Showing previously loaded notifications/);
      assert.equal(ui.animationFrames.size, 0, "Failures must not cause an immediate retry loop");
      await ui.ids.get("force-refresh").events.click();
      await ui.ids.get("groups").querySelectorAll(".mark-done")[0].events.click();
      await finishRows(ui);
      assert.equal(ui.deletions.length, 1);
      assert.match(ui.ids.get("notice").textContent, /Notification status loading paused/);
      fail = false;
      ui.advance(5000);
      await ui.fireTimer();
      await sync(ui);
      assert.equal(ui.ids.get("notice").hidden, true);
      assert.deepEqual(ui.subjectSelections.at(-1), initialRows.slice(1).map(row => row.id));
    } finally {
      ui.window.events.pagehide();
      ui.inbox.close();
    }
  }
});

test("status selection failures preserve empty, filtered and cleared inbox presentation", async () => {
  for (const mode of ["empty", "filtered", "cleared", "completed"]) {
    let fail = true;
    const initialRows = mode === "empty" ? [] : rows(1);
    const ui = await renderer({
      initialRows,
      onFetch: mode === "cleared" ? () => http(initialRows.filter(row => !row.done), { link: next }) : undefined,
      onSubjects: async () => { if (fail) throw new Error("Synthetic selection failure"); },
    });
    try {
      if (mode === "filtered") {
        ui.ids.get("search").value = "no matching notifications";
        ui.ids.get("search").events.input({});
        await ui.fireTimer(250);
      } else if (mode === "cleared" || mode === "completed") {
        await ui.ids.get("groups").querySelectorAll(".mark-done")[0].events.click();
        await finishRows(ui);
      }
      const description = ui.ids.get("empty-description").textContent;
      await sync(ui);
      assert.match(ui.ids.get("notice").textContent, /^Notification status loading paused\./);
      const caughtUp = mode === "empty" || mode === "completed";
      assert.equal(ui.ids.get("empty-title").textContent, caughtUp ? "All caught up \u{1F389}" :
        mode === "filtered" ? "No matches in loaded notifications" : "Loaded notifications cleared");
      assert.equal(ui.ids.get("empty-description").textContent, description);
      assert.equal(ui.ids.get("count").hidden, caughtUp);
      assert.equal(ui.ids.get("empty-symbol").hidden, caughtUp);
      assert.equal(ui.ids.get("empty-refresh").hidden, mode !== "cleared");
      assert.equal(ui.ids.get("force-refresh").attributes["aria-disabled"], "false");
      if (mode === "cleared") {
        await ui.ids.get("empty-refresh").events.click();
        assert.ok(ui.calls.some(call => call.path === "/api/refresh" && JSON.parse(call.options.body).force));
      }
      fail = false;
      ui.advance(5000);
      await ui.fireTimer();
      await sync(ui);
      assert.equal(ui.ids.get("notice").hidden, true);
    } finally {
      ui.window.events.pagehide();
      ui.inbox.close();
    }
  }
});

test("hiding the panel aborts status requests and stops remaining chunks without an error notice", async () => {
  let reject;
  const held = new Promise((resolve, fail) => { reject = fail; });
  const ui = await renderer({ initialRows: rows(250), onSubjects: async () => held });
  try {
    await sync(ui);
    const request = ui.calls.find(call => call.path === "/api/subjects");
    ui.intersect(false);
    assert.equal(request.options.signal.aborted, true);
    reject(Object.assign(new Error(), { name: "AbortError" }));
    await settle();
    assert.equal(selectionCalls(ui).length, 1);
    assert.equal(ui.ids.get("notice").hidden, true);
    assert.equal(ui.animationFrames.size, 0);
  } finally {
    ui.window.events.pagehide();
    ui.inbox.close();
  }
});

test("committing a selection during a poll requests a fresh snapshot after that poll completes", async () => {
  let releaseSelection;
  const heldSelection = new Promise(resolve => { releaseSelection = resolve; });
  let releaseState;
  const heldState = new Promise(resolve => { releaseState = resolve; });
  let polls = 0;
  const subjectStates = {};
  const ui = await renderer({
    initialRows: [thread()], subjectStates,
    onSubjects: async () => heldSelection,
    onState: async () => { if (++polls === 1) await heldState; },
  });
  try {
    await sync(ui);
    const poll = ui.fireTimer();
    await settle();
    subjectStates["1"] = { subjectState: "merged" };
    releaseSelection();
    await settle();
    assert.equal(polls, 1);
    releaseState();
    await poll;
    await settle();
    assert.equal(polls, 2, "The old snapshot must not swallow the selection-completion update");
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-icon")[0].attributes["aria-label"], "Pull Request: Merged");
  } finally {
    releaseSelection();
    releaseState();
    ui.window.events.pagehide();
    ui.inbox.close();
  }
});

test("a snapshot changed by another panel immediately restarts stale uploads without showing an outage", async () => {
  const initialRows = rows(250);
  let changed = false;
  const ui = await renderer({
    initialRows,
    onSubjects: async input => {
      if (input.offset === 100 && !changed) {
        changed = true;
        await ui.inbox.markDone({ id: initialRows[0].id });
      }
    },
  });
  try {
    await sync(ui);
    assert.equal(ui.ids.get("notice").hidden, true);
    assert.equal(ui.ids.get("groups").querySelectorAll(".row-link").length, 249);
    await sync(ui);
    assert.equal(ui.ids.get("notice").hidden, true);
    assert.deepEqual(ui.subjectSelections.at(-1), initialRows.slice(1).map(row => row.id));
    assert.deepEqual(selectionCalls(ui).map(({ version, offset }) => [version, offset]),
      [[1, 0], [1, 100], [2, 0], [2, 100], [2, 200]]);
    assert.equal(ui.animationFrames.size, 0);
  } finally {
    ui.window.events.pagehide();
    ui.inbox.close();
  }
});

test("malformed status selection responses stay explicit errors rather than triggering stale retries", async () => {
  for (const result of [
    null, {}, { status: "pending", version: -1 }, { status: "stale", version: "1" },
    { status: "complete", version: 1 }, { status: "pending", version: 2 },
  ]) {
    const ui = await renderer({ initialRows: rows(150), onSubjects: async () => result });
    try {
      await sync(ui);
      assert.match(ui.ids.get("notice").textContent, /invalid status selection response/);
      assert.equal(selectionCalls(ui).length, 1);
      assert.deepEqual(ui.subjectSelections, []);
      assert.equal(ui.animationFrames.size, 0);
    } finally {
      ui.window.events.pagehide();
      ui.inbox.close();
    }
  }
});
