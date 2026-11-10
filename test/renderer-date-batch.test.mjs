import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { dateLabel } from "../src/shared/model.mjs";
import { disabled, groupActionText, groupProgress, renderer, settle } from "./renderer-fixtures.mjs";
import { thread } from "./fixtures.mjs";

const selectedDate = "2026-01-12";
const otherDate = "2026-01-11";
const rows = [
  thread("1", { updated_at: new Date(2026, 0, 12, 12).toISOString(), reason: "mention" }),
  thread("2", { updated_at: new Date(2026, 0, 12, 11).toISOString(), reason: "mention", repository: { full_name: "example/other" } }),
  thread("3", { updated_at: new Date(2026, 0, 11, 12).toISOString(), reason: "mention" }),
];

function controls(ui, date = selectedDate) {
  const buttons = ui.ids.get("groups").querySelectorAll("button");
  return {
    read: buttons.find(node => node.dataset.focusKey === `bulk:date:${date}`),
    done: buttons.find(node => node.dataset.focusKey === `bulk-done:date:${date}`),
  };
}

test("each date header has independent read and Done controls without an overall date-view action", async t => {
  for (const action of ["read", "done"]) {
    const ui = await renderer({ storedSettings: { groupBy: "date" }, initialRows: rows });
    t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
    await runInContext('update("filters", { attention: "mentioned", query: "notification" })', ui.context);
    assert.equal(ui.ids.get("groups").querySelectorAll("button").some(button => button.dataset.batchScope === "shown"), false);
    assert.equal(ui.ids.get("collapse").hidden, false);
    assert.equal(groupActionText(controls(ui).read), "Mark 2 as read");
    assert.equal(groupActionText(controls(ui, otherDate).read), "Mark 1 as read");
    const first = ui.ids.get("groups").children[0];
    first.querySelectorAll("button").find(button => button.dataset.disclosure).events.click();
    assert.equal(first.children[1].hidden, true);
    const { read, done } = controls(ui);
    assert.equal(done.attributes["aria-label"], `Mark 2 as done on ${dateLabel(selectedDate)}; 2 shown, loaded notifications`);
    await (action === "done" ? done : read).events.click();
    await ui.inbox.batch.done;
    await runInContext("update()", ui.context);
    const request = JSON.parse(ui.calls.find(call => call.path === "/api/batch/start").options.body);
    assert.equal(request.scope, "date");
    assert.equal(request.date, selectedDate);
    assert.equal(request.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(request.action, action);
    assert.equal(Object.hasOwn(request, "repository"), false);
    assert.deepEqual(action === "done" ? ui.deletions : ui.patches, ["/notifications/threads/1", "/notifications/threads/2"]);
    assert.deepEqual(action === "done" ? ui.patches : ui.deletions, []);
    assert.deepEqual(ui.inbox.loadedItems().filter(item => action === "done" || item.unread).map(item => item.id), ["3"]);
    if (action === "done") assert.equal(controls(ui).read, undefined);
    else assert.equal(disabled(controls(ui).read), true);
    assert.equal(groupActionText(controls(ui, otherDate).read), "Mark 1 as read");
    assert.equal(ui.ids.get("groups").querySelectorAll("button").some(button => button.dataset.batchScope === "shown"), false);
    assert.equal(ui.ids.get("batch-progress").hidden, true);
  }
});

test("date progress stays scoped through grouping changes and completes without a Stop control", async t => {
  let release;
  const ui = await renderer({
    storedSettings: { groupBy: "date" },
    initialRows: rows,
    onWrite: (_path, count, method) => {
      assert.equal(method, "DELETE");
      return count === 1 ? new Promise(resolve => { release = () => resolve("HTTP/2 204 No Content\r\n\r\n"); })
        : "HTTP/2 204 No Content\r\n\r\n";
    },
  });
  t.after(() => { release?.(); ui.window.events.pagehide(); ui.inbox.close(); });
  await controls(ui).done.events.click();
  await settle();
  await runInContext("update()", ui.context);
  assert.equal(groupActionText(controls(ui).done), "Marking 1/2 as done...");
  assert.equal(controls(ui).done.attributes["aria-busy"], "true");
  assert.equal(controls(ui).read.attributes["aria-busy"], "false");
  assert.equal(groupActionText(controls(ui, otherDate).read), "Mark 1 as read");
  assert.equal(controls(ui, otherDate).read.attributes["aria-busy"], "false");
  assert.equal(controls(ui, otherDate).read.disabled, false);
  assert.equal(groupProgress(ui, "date:2026-1-12"), "Marking 1/2 as done...");
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.document.activeElement, controls(ui).done);
  const grouping = ui.ids.get("group-by");
  grouping.value = "none";
  grouping.events.change();
  await settle();
  const shownRead = ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === "bulk:shown");
  assert.equal(disabled(shownRead), true);
  assert.equal(groupActionText(shownRead), "Mark 2 as read");
  assert.equal(shownRead.attributes["aria-busy"], "false");
  assert.equal(ui.ids.has("batch-stop"), false);
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/2"]);
  assert.deepEqual(ui.inbox.loadedItems().map(item => item.id), ["3"]);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
});

test("date selectors stay bound to the loaded snapshot instead of silently accepting new arrivals", async t => {
  const ui = await renderer({ storedSettings: { groupBy: "date" }, initialRows: rows });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const previous = controls(ui).done;
  ui.inbox.pages[0].items.push({ ...ui.inbox.pages[0].items[0], id: "4" });
  await previous.events.click();
  assert.deepEqual(ui.deletions, []);
  assert.match(ui.ids.get("notice").textContent, /shown selection changed/);
  assert.equal(groupActionText(controls(ui).read), "Mark 3 as read");
  assert.equal(groupActionText(controls(ui, otherDate).read), "Mark 1 as read");
  assert.equal(ui.document.activeElement, controls(ui).done);
});
