import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { renderer, settle } from "./renderer-fixtures.mjs";
import { thread } from "./fixtures.mjs";

const rows = [
  thread("1", { repository: { full_name: "example/alpha" }, reason: "mention", updated_at: "2026-01-12T12:00:00Z" }),
  thread("2", { repository: { full_name: "example/beta" }, reason: "team_mention", updated_at: "2026-01-11T12:00:00Z" }),
  thread("3", { repository: { full_name: "example/gamma" }, reason: "assign", updated_at: "2026-01-10T12:00:00Z" }),
];

function controls(ui) {
  const root = ui.ids.get("shown-actions");
  const buttons = root.querySelectorAll("button");
  const read = buttons.find(node => node.dataset.focusKey === "bulk:shown");
  const more = buttons.find(node => node.dataset.focusKey === "bulk-menu:shown");
  const done = buttons.find(node => node.dataset.focusKey === "bulk-done:shown");
  return { root, read, more, done, menu: done?.parentNode };
}

test("ungrouped and date views offer bounded read and Done actions across repositories", async t => {
  for (const groupBy of ["none", "date"]) {
    for (const action of ["read", "done"]) {
      const ui = await renderer({ storedSettings: { groupBy }, initialRows: rows });
      t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
      assert.equal(controls(ui).root.hidden, false);
      assert.equal(controls(ui).read.textContent, "Mark 3 as read");
      assert.equal(ui.ids.get("collapse").hidden, groupBy === "none");
      await runInContext('update("filters", { attention: "mentioned", query: "notification" })', ui.context);
      const { read, more, done } = controls(ui);
      assert.equal(read.textContent, "Mark 2 as read");
      assert.equal(done.textContent, "Mark 2 as done");
      assert.equal(read.attributes["aria-label"], "Mark 2 shown, loaded notifications as read");
      if (groupBy === "date") ui.ids.get("collapse").events.click();
      if (action === "done") more.events.click();
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
      assert.equal(ui.inbox.summary().loaded, 1);
      assert.equal(controls(ui).root.hidden, true);
      assert.equal(ui.ids.get("empty-title").textContent, "No matches in loaded notifications");
      assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
    }
  }
});

test("list-wide controls are absent in repository and empty views and follow grouping changes", async t => {
  for (const groupBy of ["repo", "none", "date"]) {
    const ui = await renderer({ storedSettings: { groupBy }, initialRows: [] });
    t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
    assert.equal(controls(ui).root.hidden, true);
  }
  const ui = await renderer({ storedSettings: { groupBy: "none" }, initialRows: rows });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  controls(ui).more.events.click();
  const previous = controls(ui).menu;
  const grouping = ui.ids.get("group-by");
  grouping.focus();
  grouping.value = "repo";
  grouping.events.change();
  await settle();
  assert.equal(previous.hidden, true);
  assert.equal(controls(ui).root.hidden, true);
  assert.equal(ui.ids.get("groups").querySelectorAll("button").filter(node => node.dataset.batchAction === "read").length, 3);
  grouping.value = "date";
  grouping.events.change();
  await settle();
  assert.equal(controls(ui).root.hidden, false);
  assert.equal(ui.ids.get("collapse").hidden, false);
  assert.equal(controls(ui).read.textContent, "Mark 3 as read");
});

test("list-wide menus retain focus on unchanged polls and close when the selected items change", async t => {
  const ui = await renderer({ storedSettings: { groupBy: "none" }, initialRows: rows });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const initial = controls(ui);
  initial.more.events.click();
  await runInContext("update()", ui.context);
  assert.equal(initial.menu.hidden, false);
  assert.equal(ui.document.activeElement, initial.done);
  ui.inbox.pages[0].items.push({ ...ui.inbox.pages[0].items[0], id: "4", repository: "example/delta" });
  await runInContext("update()", ui.context);
  assert.equal(initial.menu.hidden, true);
  assert.equal(controls(ui).read.textContent, "Mark 4 as read");
  assert.equal(ui.document.activeElement, controls(ui).more);
  await initial.done.events.click();
  assert.deepEqual(ui.deletions, []);
  controls(ui).more.events.click();
  ui.window.events.blur();
  assert.equal(controls(ui).menu.hidden, true);
});

test("a stale list-wide selection reports the change without silently broadening the batch", async t => {
  const ui = await renderer({ storedSettings: { groupBy: "date" }, initialRows: rows });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  controls(ui).more.events.click();
  const old = controls(ui).done;
  ui.inbox.pages[0].items.push({ ...ui.inbox.pages[0].items[0], id: "4", repository: "example/delta" });
  await old.events.click();
  assert.deepEqual(ui.deletions, []);
  assert.match(ui.ids.get("notice").textContent, /shown selection changed/);
  assert.equal(controls(ui).read.textContent, "Mark 4 as read");
  assert.equal(ui.document.activeElement, controls(ui).read);
});

test("shown batch progress, cancellation and retry keep the original scope after grouping changes", async t => {
  let release;
  const ui = await renderer({ storedSettings: { groupBy: "date" }, initialRows: rows,
    onWrite: (_path, count, method) => {
      assert.equal(method, "DELETE");
      return count === 1 ? new Promise(resolve => { release = () => resolve("HTTP/2 204 No Content\r\n\r\n"); })
        : "HTTP/2 204 No Content\r\n\r\n";
    },
  });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  controls(ui).more.events.click();
  await controls(ui).done.events.click();
  await settle();
  assert.match(ui.ids.get("batch-title").textContent, /^Shown notifications: Marking as done/);
  assert.equal(controls(ui).read.textContent, "Marking 0/3...");
  assert.equal(controls(ui).read.disabled, true);
  assert.equal(controls(ui).more.disabled, true);
  assert.equal(ui.ids.get("search").disabled, true);
  assert.equal(ui.document.activeElement, ui.ids.get("batch-stop"));
  const grouping = ui.ids.get("group-by");
  grouping.value = "repo";
  grouping.events.change();
  await settle();
  assert.equal(controls(ui).root.hidden, true);
  assert.equal(ui.inbox.batch.snapshot().scope, "shown");
  await ui.ids.get("batch-stop").events.click();
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
  assert.match(ui.ids.get("batch-title").textContent, /^Shown notifications: Some notifications remain to mark as done/);
  await ui.ids.get("batch-retry").events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/3"]);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.deepEqual(ui.patches, []);
});
