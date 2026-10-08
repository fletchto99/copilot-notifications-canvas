import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { http, thread } from "./fixtures.mjs";
import { renderer, settle } from "./renderer-fixtures.mjs";

function controls(ui, repository = "example/widgets") {
  const buttons = ui.ids.get("groups").querySelectorAll("button");
  const read = buttons.find(node => node.dataset.focusKey === `bulk:${repository}`);
  const trigger = buttons.find(node => node.dataset.focusKey === `bulk-menu:${repository}`);
  const done = buttons.find(node => node.dataset.focusKey === `bulk-done:${repository}`);
  return { read, trigger, done, panel: done.parentNode };
}

test("the split control opens Done without writing and starts only the counted search selection", async t => {
  let release;
  const ui = await renderer({ initialRows: [thread("1"), thread("10"), thread("2")],
    onWrite: (_path, count, method) => {
      assert.equal(method, "DELETE");
      return count === 1 ? new Promise(resolve => { release = () => resolve("HTTP/2 204 No Content\r\n\r\n"); })
        : "HTTP/2 204 No Content\r\n\r\n";
    },
  });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  await runInContext('update("filters", { query: "notification 1" })', ui.context);
  const { read, trigger, done, panel } = controls(ui);
  assert.equal(read.textContent, "Mark 2 as read");
  assert.equal(done.textContent, "Mark 2 as done");
  assert.equal(panel.hidden, true);
  await done.events.click();
  assert.deepEqual(ui.deletions, []);
  trigger.events.click();
  assert.equal(panel.hidden, false);
  assert.equal(trigger.attributes["aria-expanded"], "true");
  assert.equal(ui.document.activeElement, done);
  assert.deepEqual(ui.deletions, []);
  ui.document.activeElement = ui.document.body;
  await done.events.click();
  await settle();
  assert.equal(panel.hidden, true);
  assert.equal(trigger.attributes["aria-expanded"], "false");
  assert.equal(ui.inbox.batch.snapshot().action, "done");
  assert.equal(ui.inbox.batch.snapshot().total, 2);
  assert.equal(ui.document.activeElement, ui.ids.get("batch-stop"));
  assert.match(ui.ids.get("batch-title").textContent, /Marking as done/);
  assert.equal(trigger.disabled, true);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
  assert.deepEqual(ui.patches, []);
  release();
  await ui.inbox.batch.done;
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/10"]);
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.inbox.summary().loaded, 1);
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
});

test("repository dropdowns dismiss on Escape, focus leaving, outside clicks and window blur", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2"),
    thread("3", { repository: { full_name: "example/other" } }), thread("4", { repository: { full_name: "example/other" } })] });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const { trigger, done, panel } = controls(ui);
  for (const dismiss of [
    () => ui.document.events.keydown({ key: "Escape", preventDefault() {} }),
    () => ui.document.events.click({ target: ui.ids.get("search") }),
    () => ui.document.events.focusin({ target: ui.ids.get("search") }),
    () => ui.window.events.blur(),
    () => trigger.events.click(),
  ]) {
    trigger.events.click();
    assert.equal(panel.hidden, false);
    assert.equal(ui.document.activeElement, done);
    dismiss();
    assert.equal(panel.hidden, true);
    assert.equal(trigger.attributes["aria-expanded"], "false");
  }
  trigger.events.click();
  ui.document.events.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(ui.document.activeElement, trigger);
  trigger.events.click();
  controls(ui, "example/other").trigger.events.click();
  assert.equal(panel.hidden, true);
  assert.equal(controls(ui, "example/other").panel.hidden, false);
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("an open split control retains focus on primary pointer presses instead of focusing its tabpanel", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const { read, trigger, panel } = controls(ui);
  const press = button => {
    let prevented = false;
    read.parentNode.events.mousedown({ button, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(press(0), false);
  trigger.events.click();
  assert.equal(panel.hidden, false);
  assert.equal(press(0), true);
  assert.equal(press(2), false);
  assert.deepEqual(ui.deletions, []);
  assert.deepEqual(ui.patches, []);
});

test("unchanged polls preserve a dropdown, but changed groups close it and focus the updated trigger", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const { trigger, panel, done } = controls(ui);
  trigger.events.click();
  await runInContext("update()", ui.context);
  assert.equal(panel.hidden, false);
  assert.equal(ui.document.activeElement, done);
  ui.inbox.pages[0].items[0].title = "Changed while choosing an action";
  await runInContext("update()", ui.context);
  const updated = controls(ui);
  assert.equal(updated.panel.hidden, true);
  assert.equal(ui.document.activeElement, updated.trigger);
  await done.events.click();
  assert.deepEqual(ui.deletions, []);
  updated.trigger.events.click();
  ui.intersect(false);
  assert.equal(updated.panel.hidden, true);
});

test("a stale Done selection refreshes the count without widening or writing the selection", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const { trigger, done } = controls(ui);
  trigger.events.click();
  ui.inbox.pages[0].items.push({ ...ui.inbox.pages[0].items[0], id: "3" });
  await done.events.click();
  assert.deepEqual(ui.deletions, []);
  assert.match(ui.ids.get("notice").textContent, /shown group changed/);
  const updated = controls(ui);
  assert.equal(updated.read.textContent, "Mark 3 as read");
  assert.equal(updated.done.textContent, "Mark 3 as done");
  assert.equal(updated.panel.hidden, true);
  assert.equal(ui.document.activeElement, updated.read);
});

test("failed Done batches show their action and retry as Done without changing the primary read action", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")], onWrite: (_path, count, method) => {
    assert.equal(method, "DELETE");
    return count === 1 ? http({}, {}, 500) : "HTTP/2 204 No Content\r\n\r\n";
  } });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  controls(ui).trigger.events.click();
  await controls(ui).done.events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.match(ui.ids.get("batch-title").textContent, /remain to mark as done/);
  assert.equal(controls(ui).read.textContent, "Mark 2 as read");
  assert.equal(ui.ids.get("batch-retry").disabled, true);
  ui.advance();
  await runInContext("update()", ui.context);
  await ui.ids.get("batch-retry").events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/1", "/notifications/threads/2"]);
  assert.deepEqual(ui.patches, []);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
});

test("metadata omits the redundant unread label and uses decorative middle-dot separators", async t => {
  for (const groupBy of ["repo", "date", "none"]) {
    const ui = await renderer({ storedSettings: { groupBy }, initialRows: [thread()] });
    t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
    const metadata = ui.ids.get("groups").querySelectorAll(".metadata")[0];
    const items = metadata.querySelectorAll(".metadata-item");
    assert.equal(items.length, groupBy === "repo" ? 3 : 4);
    assert.equal(items.some(part => part.children[0].textContent === "Unread"), false);
    assert.equal(items.at(-1).children.length, 1);
    const separators = metadata.querySelectorAll(".metadata-separator");
    assert.equal(separators.length, items.length - 1);
    for (const separator of separators) {
      assert.equal(separator.textContent, "\u00b7");
      assert.equal(separator.attributes["aria-hidden"], "true");
      assert.equal(separator.parentNode.className, "metadata-item");
      assert.equal(separator.parentNode.children.at(-1), separator);
    }
  }
});
