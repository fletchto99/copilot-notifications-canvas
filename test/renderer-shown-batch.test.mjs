import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { groupActionText, renderer, settle } from "./renderer-fixtures.mjs";
import { thread } from "./fixtures.mjs";

const rows = [
  thread("1", { repository: { full_name: "example/alpha" }, reason: "mention", updated_at: "2026-01-12T12:00:00Z" }),
  thread("2", { repository: { full_name: "example/beta" }, reason: "mention", updated_at: "2026-01-11T12:00:00Z" }),
  thread("3", { repository: { full_name: "example/gamma" }, reason: "assign", updated_at: "2026-01-10T12:00:00Z" }),
];

function controls(ui) {
  const buttons = ui.ids.get("groups").querySelectorAll("button");
  const read = buttons.find(node => node.dataset.focusKey === "bulk:shown");
  const done = buttons.find(node => node.dataset.focusKey === "bulk-done:shown");
  return { root: read?.parentNode.parentNode.parentNode.parentNode, read, done };
}

test("the All notifications header offers bounded read and Done actions across repositories", async t => {
  for (const action of ["read", "done"]) {
    const ui = await renderer({ storedSettings: { groupBy: "none" }, initialRows: rows });
    t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
    assert.equal(controls(ui).root.hidden, false);
    assert.equal(controls(ui).root.className, "repo-group");
    assert.equal(controls(ui).read.parentNode.parentNode.parentNode.className, "repo-header");
    assert.equal(controls(ui).root.querySelectorAll(".repo-name")[0].textContent, "All notifications");
    assert.equal(controls(ui).root.querySelectorAll(".repo-count")[0].textContent, "3 total \u00b7 3 unread");
    assert.equal(groupActionText(controls(ui).read), "Mark 3 as read");
    assert.equal(ui.ids.get("collapse").hidden, false);
    await runInContext('update("filters", { attention: "mentioned", query: "notification" })', ui.context);
    const { read, done } = controls(ui);
    assert.equal(groupActionText(read), "Mark 2 as read");
    assert.equal(groupActionText(done), "Mark 2 as done");
    assert.equal(read.attributes["aria-label"], "Mark 2 as read; 2 shown, loaded notifications");
    await (action === "done" ? done : read).events.click();
    const request = ui.calls.find(call => call.path === "/api/batch/start");
    const input = JSON.parse(request.options.body);
    assert.equal(input.scope, "shown");
    assert.equal(input.action, action);
    assert.equal(Object.hasOwn(input, "repository"), false);
    await ui.inbox.batch.done;
    await runInContext("update()", ui.context);
    assert.deepEqual(action === "done" ? ui.deletions : ui.patches, ["/notifications/threads/1", "/notifications/threads/2"]);
    assert.deepEqual(action === "done" ? ui.patches : ui.deletions, []);
    assert.equal(ui.inbox.summary().loaded, action === "done" ? 1 : 3);
    if (action === "done") assert.equal(controls(ui).root, undefined);
    else assert.equal(controls(ui).read.disabled, true);
    assert.equal(ui.ids.get("collapse").hidden, action === "done");
    assert.equal(ui.ids.get("empty").hidden, action === "read");
    assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
  }
});

test("the single group's collapse state survives polls, filtering and grouping changes", async t => {
  const ui = await renderer({ storedSettings: { groupBy: "none" }, initialRows: rows });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const disclosure = () => controls(ui).root.querySelectorAll("button").find(node => node.dataset.disclosure);
  disclosure().focus();
  disclosure().events.click();
  assert.equal(disclosure().attributes["aria-expanded"], "false");
  assert.equal(controls(ui).root.children[1].hidden, true);
  assert.equal(ui.ids.get("collapse").textContent, "Expand all");
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement, disclosure());
  await runInContext('update("filters", { attention: "mentioned" })', ui.context);
  assert.equal(controls(ui).root.children[1].hidden, true);
  assert.equal(groupActionText(controls(ui).read), "Mark 2 as read");
  assert.equal(controls(ui).root.querySelectorAll(".repo-count")[0].textContent, "2 total \u00b7 2 unread");
  const grouping = ui.ids.get("group-by");
  for (const groupBy of ["date", "repo", "none"]) {
    grouping.focus();
    grouping.value = groupBy;
    grouping.events.change();
    await settle();
    assert.equal(ui.document.activeElement, grouping);
    assert.ok(ui.ids.get("groups").children.every(group => group.children[1].hidden === (groupBy === "none")));
  }
  ui.ids.get("collapse").events.click();
  assert.equal(disclosure().attributes["aria-expanded"], "true");
  assert.equal(controls(ui).root.children[1].hidden, false);
  assert.equal(ui.ids.get("collapse").textContent, "Collapse all");
  ui.ids.get("collapse").events.click();
  assert.equal(controls(ui).root.children[1].hidden, true);
  disclosure().events.click();
  assert.equal(ui.ids.get("collapse").textContent, "Collapse all");
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("collapsed All notifications groups retain their bounded read and Done actions", async t => {
  for (const action of ["read", "done"]) {
    const ui = await renderer({ storedSettings: { groupBy: "none" }, initialRows: rows });
    t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
    await runInContext('update("filters", { attention: "mentioned" })', ui.context);
    ui.ids.get("collapse").events.click();
    const { root, read, done } = controls(ui);
    assert.equal(root.children[1].hidden, true);
    assert.equal(read.disabled, false);
    const button = action === "done" ? done : read;
    button.focus();
    await button.events.click();
    await ui.inbox.batch.done;
    await runInContext("update()", ui.context);
    assert.deepEqual(action === "done" ? ui.deletions : ui.patches, ["/notifications/threads/1", "/notifications/threads/2"]);
    assert.deepEqual(ui.inbox.loadedItems().filter(item => action === "done" || item.unread).map(item => item.id), ["3"]);
    if (action === "done") assert.equal(controls(ui).root, undefined);
    else assert.equal(controls(ui).read.disabled, true);
    assert.equal(ui.document.activeElement, ui.ids.get("search"));
  }
});

test("list-wide controls are absent in repository and empty views and follow grouping changes", async t => {
  for (const groupBy of ["repo", "none", "date"]) {
    const ui = await renderer({ storedSettings: { groupBy }, initialRows: [] });
    t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
    assert.equal(controls(ui).root, undefined);
  }
  const ui = await renderer({ storedSettings: { groupBy: "none" }, initialRows: rows });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const grouping = ui.ids.get("group-by");
  grouping.focus();
  grouping.value = "repo";
  grouping.events.change();
  await settle();
  assert.equal(controls(ui).root, undefined);
  assert.equal(ui.ids.get("groups").querySelectorAll("button").filter(node => node.dataset.batchAction === "read").length, 3);
  grouping.value = "date";
  grouping.events.change();
  await settle();
  assert.equal(controls(ui).root, undefined);
  assert.equal(ui.ids.get("collapse").hidden, false);
  assert.equal(ui.ids.get("groups").querySelectorAll("button").filter(node => node.dataset.batchScope === "date" && node.dataset.batchAction === "read").length, 3);
});

test("list-wide actions retain focus on unchanged polls and updated counts", async t => {
  const ui = await renderer({ storedSettings: { groupBy: "none" }, initialRows: rows });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const initial = controls(ui);
  initial.done.focus();
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement, initial.done);
  ui.inbox.pages[0].items.push({ ...ui.inbox.pages[0].items[0], id: "4", repository: "example/delta" });
  await runInContext("update()", ui.context);
  assert.equal(groupActionText(controls(ui).read), "Mark 4 as read");
  assert.equal(ui.document.activeElement, controls(ui).done);
  await initial.done.events.click();
  assert.deepEqual(ui.deletions, []);
  ui.window.events.blur();
  assert.deepEqual(ui.deletions, []);
});

test("a stale list-wide selection reports the change without silently broadening the batch", async t => {
  const ui = await renderer({ storedSettings: { groupBy: "none" }, initialRows: rows });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const old = controls(ui).done;
  ui.inbox.pages[0].items.push({ ...ui.inbox.pages[0].items[0], id: "4", repository: "example/delta" });
  await old.events.click();
  assert.deepEqual(ui.deletions, []);
  assert.match(ui.ids.get("notice").textContent, /shown selection changed/);
  assert.equal(groupActionText(controls(ui).read), "Mark 4 as read");
  assert.equal(ui.document.activeElement, controls(ui).done);
});

test("shown batch progress, cancellation and retry keep the original scope after grouping changes", async t => {
  let release;
  const ui = await renderer({ storedSettings: { groupBy: "none" }, initialRows: rows,
    onWrite: (_path, count, method) => {
      assert.equal(method, "DELETE");
      return count === 1 ? new Promise(resolve => { release = () => resolve("HTTP/2 204 No Content\r\n\r\n"); })
        : "HTTP/2 204 No Content\r\n\r\n";
    },
  });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  await controls(ui).done.events.click();
  await settle();
  assert.match(ui.ids.get("batch-title").textContent, /^Shown notifications: Marking as done/);
  assert.equal(groupActionText(controls(ui).done), "Marking 0/3...");
  assert.equal(controls(ui).read.disabled, true);
  assert.equal(controls(ui).done.disabled, true);
  assert.equal(ui.ids.get("search").disabled, true);
  assert.equal(ui.document.activeElement, ui.ids.get("batch-stop"));
  const grouping = ui.ids.get("group-by");
  grouping.value = "repo";
  grouping.events.change();
  await settle();
  assert.equal(controls(ui).root, undefined);
  assert.equal(ui.inbox.batch.snapshot().scope, "shown");
  await ui.ids.get("batch-stop").events.click();
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
  assert.equal(ui.ids.get("batch-title").textContent, "Shown notifications: Stopped");
  assert.equal(ui.ids.get("batch-counts").textContent, "1 marked done, 2 remaining");
  await ui.ids.get("batch-retry").events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/3"]);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.deepEqual(ui.patches, []);
});
