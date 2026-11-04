import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { http, thread } from "./fixtures.mjs";
import { groupActionText, renderer, settle } from "./renderer-fixtures.mjs";

function controls(ui, repository = "example/widgets") {
  const buttons = ui.ids.get("groups").querySelectorAll("button");
  const read = buttons.find(node => node.dataset.focusKey === `bulk:${repository}`);
  const done = buttons.find(node => node.dataset.focusKey === `bulk-done:${repository}`);
  return { read, done };
}

test("direct Done starts only the counted search selection and disables both actions while running", async t => {
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
  const { read, done } = controls(ui);
  assert.equal(groupActionText(read), "Mark 2 as read");
  assert.equal(groupActionText(done), "Mark 2 as done");
  assert.deepEqual(read.parentNode.parentNode.children.map(anchor => anchor.children[0]), [read, done]);
  assert.equal(read.textContent, "");
  assert.equal(done.textContent, "");
  assert.deepEqual(ui.deletions, []);
  ui.document.activeElement = ui.document.body;
  const started = done.events.click();
  await done.events.click();
  await started;
  await settle();
  assert.equal(ui.inbox.batch.snapshot().action, "done");
  assert.equal(ui.inbox.batch.snapshot().total, 2);
  assert.equal(ui.document.activeElement, ui.ids.get("batch-stop"));
  assert.match(ui.ids.get("batch-title").textContent, /Marking as done/);
  assert.equal(read.disabled, true);
  assert.equal(done.disabled, true);
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

test("focus, Escape and blur never start either group action", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2"),
    thread("3", { repository: { full_name: "example/other" } }), thread("4", { repository: { full_name: "example/other" } })] });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const { read, done } = controls(ui);
  for (const leave of [
    () => ui.document.events.keydown({ key: "Escape", preventDefault() {} }),
    () => ui.document.events.click({ target: ui.ids.get("search") }),
    () => ui.document.events.focusin({ target: ui.ids.get("search") }),
    () => ui.window.events.blur(),
  ]) {
    read.focus();
    done.focus();
    leave();
    assert.equal(done.disabled, false);
  }
  assert.equal(ui.ids.get("groups").querySelectorAll(".repo-menu").length, 0);
  assert.equal(ui.ids.get("groups").querySelectorAll(".repo-more").length, 0);
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("unchanged and changed polls preserve focus on the same explicit action", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const { done } = controls(ui);
  done.focus();
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement, done);
  ui.inbox.pages[0].items[0].title = "Changed while choosing an action";
  await runInContext("update()", ui.context);
  const updated = controls(ui);
  assert.equal(ui.document.activeElement, updated.done);
  assert.deepEqual(ui.deletions, []);
  ui.intersect(false);
  await updated.done.events.click();
  assert.deepEqual(ui.deletions, []);
});

test("a stale Done selection refreshes the count without widening or writing the selection", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const { done } = controls(ui);
  ui.inbox.pages[0].items.push({ ...ui.inbox.pages[0].items[0], id: "3" });
  await done.events.click();
  assert.deepEqual(ui.deletions, []);
  assert.match(ui.ids.get("notice").textContent, /shown selection changed/);
  const updated = controls(ui);
  assert.equal(groupActionText(updated.read), "Mark 3 as read");
  assert.equal(groupActionText(updated.done), "Mark 3 as done");
  assert.equal(ui.document.activeElement, updated.done);
});

test("failed Done batches show their action and retry as Done without changing the primary read action", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")], onWrite: (_path, count, method) => {
    assert.equal(method, "DELETE");
    return count === 1 ? http({}, {}, 500) : "HTTP/2 204 No Content\r\n\r\n";
  } });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  await controls(ui).done.events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.match(ui.ids.get("batch-title").textContent, /remain to mark as done/);
  assert.equal(groupActionText(controls(ui).read), "Mark 2 as read");
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

test("batch retry waits for pending search without expanding its original scope", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")],
    onWrite: (_path, count) => count === 1 ? http({}, {}, 500) : "HTTP/2 204 No Content\r\n\r\n",
  });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  await controls(ui).done.events.click();
  await ui.inbox.batch.done;
  ui.advance();
  await runInContext("update()", ui.context);
  const retry = ui.ids.get("batch-retry");
  assert.equal(retry.disabled, false);
  const search = ui.ids.get("search");
  search.value = "notification 2";
  search.events.input();
  assert.equal(retry.disabled, true);
  await runInContext("render()", ui.context);
  assert.equal(retry.disabled, true);
  await retry.events.click();
  assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
  await ui.fireTimer(250);
  assert.equal(retry.disabled, false);
  await retry.events.click();
  await ui.inbox.batch.done;
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/2"]);
  assert.deepEqual(ui.patches, []);
});
