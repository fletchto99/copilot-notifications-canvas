import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { http, thread } from "./fixtures.mjs";
import { disabled, finishRows, groupActionText, groupProgress, renderer, settle } from "./renderer-fixtures.mjs";

function controls(ui, repository = "example/widgets") {
  const buttons = ui.ids.get("groups").querySelectorAll("button");
  const read = buttons.find(node => node.dataset.focusKey === `bulk:${repository}`);
  const done = buttons.find(node => node.dataset.focusKey === `bulk-done:${repository}`);
  return { read, done };
}

test("accepted group actions check dispatch state without waiting for the progress timer", async t => {
  for (const action of ["read", "done"]) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const ui = await renderer({ initialRows: [thread("1"), thread("2")],
      onWrite: async (_path, _count, method) => {
        await held;
        return `HTTP/2 ${method === "DELETE" ? 204 : 205} Synthetic\r\n\r\n`;
      },
      onActionResponse: (_path, snapshot) => {
        assert.equal(snapshot.batch.inFlight, false, "The acknowledgement precedes dispatch");
      },
    });
    t.after(() => { release(); ui.window.events.pagehide(); ui.inbox.close(); });
    const stateReads = () => ui.calls.filter(call => call.path === "/api/state").length;
    const before = stateReads();
    const button = controls(ui)[action];
    await button.events.click();
    await settle();
    assert.equal(stateReads(), before + 1);
    assert.equal(button.dataset.writeState, "active");
    assert.equal(ui.document.activeElement, button);
    assert.equal(groupProgress(ui, "repo:example/widgets"), `Marking 0/2 as ${action}...`);
    release();
    await ui.inbox.batch.done;
  }
});

test("an accepted group action remains queued when no write has been dispatched", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  let release;
  ui.inbox.client.pageQueue = new Promise(resolve => { release = resolve; });
  t.after(() => { release(); ui.window.events.pagehide(); ui.inbox.close(); });
  const before = ui.calls.filter(call => call.path === "/api/state").length;
  const button = controls(ui).done;
  await button.events.click();
  await settle();
  assert.equal(ui.calls.filter(call => call.path === "/api/state").length, before + 1);
  assert.equal(button.dataset.writeState, "queued");
  assert.equal(groupProgress(ui, "repo:example/widgets"), "Queued 0/2 as done...");
  assert.deepEqual(ui.deletions, []);
  release();
  await ui.inbox.batch.done;
});

test("accepted row actions check dispatch state without waiting for the progress timer", async t => {
  for (const action of ["read", "done"]) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const ui = await renderer({ initialRows: [thread("1"), thread("2")],
      onWrite: async (_path, _count, method) => {
        await held;
        return `HTTP/2 ${method === "DELETE" ? 204 : 205} Synthetic\r\n\r\n`;
      },
      onActionResponse: (_path, snapshot) => {
        const row = snapshot.batches.find(batch => batch.token === snapshot.rowActionToken);
        assert.equal(row.inFlight, false, "The acknowledgement precedes dispatch");
      },
    });
    t.after(() => { release(); ui.window.events.pagehide(); ui.inbox.close(); });
    const before = ui.calls.filter(call => call.path === "/api/state").length;
    const button = ui.ids.get("groups").querySelectorAll("button")
      .find(button => button.dataset.focusKey === `${action}:1`);
    button.focus();
    await button.events.click();
    await settle();
    assert.equal(ui.calls.filter(call => call.path === "/api/state").length, before + 1);
    assert.equal(button.dataset.writeState, "active");
    assert.equal(groupActionText(button), `Marking as ${action}`);
    release();
    await finishRows(ui);
    assert.equal(ui.document.activeElement.dataset.focusKey, action === "read" ? "done:1" : "done:2");
  }
});

test("an accepted row action remains queued when no write has been dispatched", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  let release;
  ui.inbox.client.pageQueue = new Promise(resolve => { release = resolve; });
  t.after(() => { release(); ui.window.events.pagehide(); ui.inbox.close(); });
  const before = ui.calls.filter(call => call.path === "/api/state").length;
  const button = ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === "done:1");
  await button.events.click();
  await settle();
  assert.equal(ui.calls.filter(call => call.path === "/api/state").length, before + 1);
  assert.equal(button.dataset.writeState, "queued");
  assert.equal(groupActionText(button), "Queued to mark as done");
  assert.deepEqual(ui.deletions, []);
  release();
  await ui.inbox.batch.done;
});

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
  let { read, done } = controls(ui);
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
  ({ read, done } = controls(ui));
  assert.equal(ui.inbox.batch.snapshot().action, "done");
  assert.equal(ui.inbox.batch.snapshot().total, 2);
  assert.equal(ui.document.activeElement, done);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  await runInContext("update()", ui.context);
  assert.equal(groupProgress(ui, "repo:example/widgets"), "Marking 1/2 as done...");
  assert.equal(disabled(read), true);
  assert.equal(disabled(done), true);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/10"]);
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
  assert.equal(groupActionText(controls(ui).read), "Mark 1 as read");
  assert.equal(ui.ids.get("batch-retry").disabled, true);
  ui.advance();
  await runInContext("update()", ui.context);
  await ui.ids.get("batch-retry").events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/1"]);
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
    onWrite: (_path, count) => count <= 2 ? http({}, {}, 500) : "HTTP/2 204 No Content\r\n\r\n",
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
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/2"]);
  await ui.fireTimer(250);
  assert.equal(retry.disabled, false);
  await retry.events.click();
  await ui.inbox.batch.done;
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/2"]);
  assert.deepEqual(ui.patches, []);
});

test("pending row responses lock only their row and cannot overwrite a newer completed action", async t => {
  let release;
  const ui = await renderer({ initialRows: [thread("1"), thread("2"), thread("3")],
    onActionResponse: path => path === "/api/read" ? new Promise(resolve => { release = resolve; }) : undefined,
  });
  t.after(() => { release?.(); ui.window.events.pagehide(); ui.inbox.close(); });
  const button = key => ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === key);
  const first = button("read:1").events.click();
  await settle();
  assert.equal(button("done:1").disabled, true);
  assert.equal(button("done:2").disabled, false);
  assert.equal(disabled(controls(ui).done), true);
  await button("done:1").events.click();
  button("done:2").focus();
  await button("done:2").events.click();
  await finishRows(ui);
  const focused = ui.document.activeElement;
  assert.deepEqual(ui.deletions, ["/notifications/threads/2"]);
  assert.equal(button("done:2"), undefined);
  release();
  await first;
  assert.equal(button("done:2"), undefined);
  assert.equal(button("read:1"), undefined);
  assert.equal(button("done:1").disabled, false);
  assert.equal(ui.document.activeElement, focused);
  assert.equal(controls(ui).done.disabled, false);
});

test("parallel group requests have scoped locks and independent progress without Stop controls", async t => {
  const releases = [];
  let releaseResponse;
  const ui = await renderer({ initialRows: [
    thread("1"), thread("2"),
    thread("3", { repository: { full_name: "example/other" } }),
    thread("4", { repository: { full_name: "example/other" } }),
    thread("5", { repository: { full_name: "example/solo" } }),
  ], onWrite: (_path, _count, method) =>
    new Promise(resolve => { releases.push(() => resolve(`HTTP/2 ${method === "DELETE" ? 204 : 205} Synthetic\r\n\r\n`)); }),
  onActionResponse: (path, state) => path === "/api/batch/start" && state.batches.length === 1
    ? new Promise(resolve => { releaseResponse = resolve; }) : undefined,
  });
  t.after(() => { releases.forEach(release => release()); releaseResponse?.(); ui.window.events.pagehide(); ui.inbox.close(); });
  const first = controls(ui).read.events.click();
  await settle();
  assert.equal(disabled(controls(ui).done), true);
  assert.equal(controls(ui, "example/other").done.disabled, false);
  await controls(ui, "example/other").done.events.click();
  await settle();
  await runInContext("update()", ui.context);
  assert.equal(ui.inbox.batch.snapshots().length, 2);
  assert.equal(ui.ids.get("additional-batches").querySelectorAll("section").length, 0);
  const second = controls(ui, "example/other").done;
  assert.equal(groupProgress(ui, "repo:example/widgets"), "Marking 0/2 as read...");
  assert.equal(groupProgress(ui, "repo:example/other"), "Marking 0/2 as done...");
  assert.equal(ui.document.activeElement, second);
  releaseResponse();
  await first;
  assert.equal(ui.inbox.batch.snapshots().length, 2);
  assert.equal(ui.document.activeElement, second, "the older response must not steal focus");
  assert.equal(ui.inbox.batch.snapshots()[0].status, "running");
  assert.equal(ui.inbox.batch.snapshots()[1].status, "running");
  await controls(ui, "example/solo").done.events.click();
  await settle();
  releases.forEach(release => release());
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("additional-batches").querySelectorAll("section").length, 0);
  assert.deepEqual(ui.patches, ["/notifications/threads/1", "/notifications/threads/2"]);
  assert.deepEqual(new Set(ui.deletions), new Set(["/notifications/threads/3", "/notifications/threads/4", "/notifications/threads/5"]));
});

test("finishing a focused batch leaves focus usable while another batch is running", async t => {
  const releases = [];
  const ui = await renderer({ initialRows: [
    thread("1"), thread("2", { repository: { full_name: "example/other" } }),
  ], onWrite: () => new Promise(resolve => { releases.push(() => resolve("HTTP/2 205 Reset Content\r\n\r\n")); }) });
  t.after(() => { for (const release of releases) release(); ui.window.events.pagehide(); ui.inbox.close(); });
  await controls(ui).read.events.click();
  await controls(ui, "example/other").read.events.click();
  await settle();
  controls(ui).read.focus();
  releases[0]();
  await settle();
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("search").disabled, false);
  assert.equal(groupProgress(ui, "repo:example/other"), "Marking 0/1 as read...");
  assert.equal(ui.document.activeElement.dataset.focusKey, "repo:example/widgets");
  releases[1]();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement.dataset.focusKey, "repo:example/widgets");
});

test("inline failures follow the group and remain retryable when filtering or regrouping hides it", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2"), thread("3", { repository: { full_name: "example/other" } })],
    onWrite: (_path, count) => count <= 2 ? http({}, {}, 500) : "HTTP/2 204 No Content\r\n\r\n" });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  await controls(ui).done.events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  const result = ui.ids.get("batch-progress");
  assert.equal(result.parentNode.className, "group-results");
  assert.equal(result.parentNode.parentNode.querySelectorAll(".repo-name")[0].textContent, "example/widgets");
  await runInContext('update("filters", { query: "notification 3" })', ui.context);
  assert.equal(result.parentNode, ui.ids.get("additional-batches"));
  assert.equal(result.hidden, false);
  assert.match(ui.ids.get("batch-title").textContent, /example\/widgets/);
  await runInContext('update("filters", { query: "notification 2" })', ui.context);
  assert.equal(result.parentNode.className, "group-results");
  const grouping = ui.ids.get("group-by");
  grouping.value = "none";
  grouping.events.change();
  await settle();
  assert.equal(result.parentNode, ui.ids.get("additional-batches"));
  ui.advance();
  await runInContext("update()", ui.context);
  await ui.ids.get("batch-retry").events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/2"]);
  assert.equal(result.hidden, true);
});

test("row actions expose queued and active status while search remains usable", async t => {
  const releases = [];
  const ui = await renderer({ initialRows: [thread("1"), thread("2")],
    onWrite: () => new Promise(resolve => { releases.push(() => resolve("HTTP/2 205 Reset Content\r\n\r\n")); }) });
  t.after(() => { releases.forEach(release => release()); ui.window.events.pagehide(); ui.inbox.close(); });
  const buttons = () => ui.ids.get("groups").querySelectorAll(".mark-read");
  const first = buttons()[0].events.click();
  const second = buttons()[1].events.click();
  assert.deepEqual(buttons().map(button => button.dataset.writeState), ["queued", "queued"]);
  await settle();
  await runInContext("update()", ui.context);
  assert.deepEqual(buttons().map(button => button.dataset.writeState), ["active", "active"]);
  assert.equal(groupActionText(buttons()[1]), "Marking as read");
  assert.equal(ui.ids.get("search").disabled, false);
  releases[0]();
  await first;
  await settle();
  await runInContext("update()", ui.context);
  assert.deepEqual(buttons().map(button => button.dataset.writeState), ["active"]);
  releases[1]();
  await second;
  await finishRows(ui);
  assert.equal(buttons().length, 0);
});

test("parallel failures keep independent inline results and dismissing one preserves the other", async t => {
  const releases = [];
  const ui = await renderer({ initialRows: [thread("1"), thread("2", { repository: { full_name: "example/other" } })],
    onWrite: () => new Promise(resolve => { releases.push(() => resolve(http({}, {}, 500))); }) });
  t.after(() => { releases.forEach(release => release()); ui.window.events.pagehide(); ui.inbox.close(); });
  await controls(ui).done.events.click();
  await controls(ui, "example/other").done.events.click();
  await settle();
  releases.forEach(release => release());
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  const results = ui.ids.get("groups").querySelectorAll(".group-results");
  const first = results[0].children[0];
  const second = results[1].children[0];
  assert.equal(first, ui.ids.get("batch-progress"));
  assert.equal(second.className, "batch-progress");
  assert.match(second.querySelectorAll("h2")[0].textContent, /example\/other/);
  const buttons = second.querySelectorAll("button");
  assert.equal(buttons[0].textContent, "Retry remaining (1)");
  assert.equal(buttons[0].disabled, true);
  buttons[1].focus();
  await buttons[1].events.click();
  assert.equal(results[1].children.length, 0);
  assert.equal(first.hidden, false);
  assert.equal(ui.inbox.batch.snapshots().length, 1);
  assert.equal(ui.inbox.batch.snapshot().repository, "example/widgets");
});

test("batch retries ignore locked original targets that are no longer shown", async t => {
  let release;
  const ui = await renderer({ initialRows: [thread("1"), thread("2")],
    onWrite: (_path, count) => count <= 2 ? http({}, {}, 500) : count === 3
      ? new Promise(resolve => { release = () => resolve("HTTP/2 204 No Content\r\n\r\n"); })
      : "HTTP/2 204 No Content\r\n\r\n" });
  t.after(() => { release?.(); ui.window.events.pagehide(); ui.inbox.close(); });
  await controls(ui).done.events.click();
  await ui.inbox.batch.done;
  ui.advance();
  await runInContext("update()", ui.context);
  const row = ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === "done:1");
  await row.events.click();
  await settle();
  await runInContext('update("filters", { query: "notification 2" })', ui.context);
  const retry = ui.ids.get("batch-retry");
  assert.equal(retry.disabled, false);
  assert.deepEqual(ui.inbox.batch.snapshots().find(batch => batch.scope === "repository").retryableThreadIds, ["2"]);
  await retry.events.click();
  assert.equal(ui.inbox.batch.snapshots().find(batch => batch.scope === "repository"), undefined);
  assert.equal(ui.inbox.batch.snapshots().find(batch => batch.scope === "thread").status, "running");
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/1", "/notifications/threads/2"]);
});

test("status polls hand off shortcut focus before a delayed acknowledgement without overriding newer focus", async t => {
  for (const [action, moveFocus, fromButton] of [
    ["read", false, false], ["read", true, false], ["done", false, false], ["done", true, false],
    ["read", false, true], ["done", false, true],
  ]) {
    let release;
    const ui = await renderer({ initialRows: [thread("1"), thread("2"), thread("3")],
      retainDisabledFocus: true,
      storedSettings: { matchGitHubInbox: action !== "read" },
      onActionResponse: () => new Promise(resolve => { release = resolve; }) });
    t.after(() => { release?.(); ui.window.events.pagehide(); ui.inbox.close(); });
    const link = ui.ids.get("groups").querySelectorAll(fromButton ? `.mark-${action}` : ".row-link")[0];
    link.focus();
    const pending = runInContext(`markThread("1", "${action}", true)`, ui.context);
    await settle();
    await ui.inbox.batch.done;
    if (moveFocus) ui.ids.get("search").focus();
    await runInContext("update()", ui.context);
    const next = ui.ids.get("groups").querySelectorAll(".row-link")[0];
    assert.equal(next.dataset.threadId, "2");
    assert.equal(ui.document.activeElement, moveFocus ? ui.ids.get("search") : next);
    release();
    await pending;
    assert.equal(ui.document.activeElement, moveFocus ? ui.ids.get("search") : next);
  }
});

test("All-view Read completion unlocks Done and restores focus before acknowledgement", async t => {
  for (const retainDisabledFocus of [false, true]) {
    for (const moveFocus of [false, true]) {
      let release;
      const ui = await renderer({ initialRows: [thread("1"), thread("2")], retainDisabledFocus,
        onActionResponse: () => new Promise(resolve => { release = resolve; }) });
      t.after(() => { release?.(); ui.window.events.pagehide(); ui.inbox.close(); });
      const button = key => ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === key);
      const read = button("read:1");
      read.focus();
      const pending = read.events.click();
      await settle();
      await ui.inbox.batch.done;
      if (moveFocus) ui.ids.get("search").focus();
      await runInContext("update()", ui.context);
      assert.equal(button("read:1"), undefined);
      assert.equal(button("done:1").disabled, false);
      const expected = moveFocus ? ui.ids.get("search") : button("done:1");
      assert.equal(ui.document.activeElement, expected);
      release();
      await pending;
      assert.equal(ui.document.activeElement, expected);
      assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
      assert.deepEqual(ui.deletions, []);
    }
  }
});

test("late Read acknowledgements cannot clear a newer Done action or report a confirmed Read as failed", async t => {
  for (const failAcknowledgement of [false, true]) {
    let releaseRead;
    let releaseDone;
    const ui = await renderer({ initialRows: [thread("1"), thread("2")],
      onActionResponse: path => path === "/api/read" ? new Promise((resolve, reject) => {
        releaseRead = () => failAcknowledgement ? reject(new Error("Synthetic lost acknowledgement")) : resolve();
      }) : undefined,
      onWrite: (_path, _count, method) => method === "DELETE"
        ? new Promise(resolve => { releaseDone = () => resolve("HTTP/2 204 No Content\r\n\r\n"); })
        : "HTTP/2 205 Reset Content\r\n\r\n",
    });
    t.after(() => { releaseRead?.(); releaseDone?.(); ui.window.events.pagehide(); ui.inbox.close(); });
    const button = key => ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === key);
    button("read:1").focus();
    const pending = button("read:1").events.click();
    await settle();
    await finishRows(ui);
    assert.equal(button("done:1").disabled, false);
    await button("done:1").events.click();
    await settle();
    const operation = runInContext('marking.get("1")', ui.context);
    assert.equal(operation.action, "done");
    ui.ids.get("search").focus();
    releaseRead();
    await pending;
    assert.equal(runInContext('marking.get("1")', ui.context), operation);
    assert.equal(button("done:1").disabled, true);
    assert.equal(ui.ids.get("notice").hidden, true);
    assert.equal(ui.document.activeElement, ui.ids.get("search"));
    releaseDone();
    await finishRows(ui);
    assert.equal(button("done:1"), undefined);
    assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
    assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
  }
});

test("lost acknowledgements recover queued Read and Done outcomes instead of reporting transport failures", async t => {
  for (const action of ["read", "done"]) {
    for (const matchGitHubInbox of [false, true]) {
      for (const failWrite of [false, true]) {
        let release;
        const ui = await renderer({ initialRows: [thread("1"), thread("2")], storedSettings: { matchGitHubInbox },
          onActionResponse: () => { throw new Error("Synthetic lost acknowledgement"); },
          onWrite: () => new Promise(resolve => {
            release = () => resolve(failWrite ? http({}, {}, 500) : `HTTP/2 ${action === "done" ? 204 : 205} Synthetic\r\n\r\n`);
          }),
        });
        t.after(() => { release?.(); ui.window.events.pagehide(); ui.inbox.close(); });
        const button = ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === `${action}:1`);
        button.focus();
        await button.events.click();
        await settle();
        assert.equal(ui.ids.get("notice").hidden, true);
        assert.equal(runInContext('Boolean(marking.get("1").token)', ui.context), true);
        await runInContext('update("filters", { query: "notification 2" })', ui.context);
        assert.equal(runInContext('marking.has("1")', ui.context), true, "filtering out the row is not completion");
        release();
        await finishRows(ui);
        assert.equal(runInContext("marking.size", ui.context), 0);
        assert.equal(ui.ids.get("notice").hidden, !failWrite);
        if (failWrite) {
          assert.match(ui.ids.get("notice").textContent, /HTTP 500/);
          assert.doesNotMatch(ui.ids.get("notice").textContent, /lost acknowledgement/);
        } else {
          await runInContext("update()", ui.context);
          assert.deepEqual(ui.inbox.batch.snapshots(), [], "the next state poll acknowledges the rendered receipt");
        }
        assert.equal(ui.patches.length + ui.deletions.length, 1);
      }
    }
  }
});

test("completed Done receipts resolve tokenless actions before lost acknowledgements without stealing moved focus", async t => {
  for (const moveFocus of [false, true]) {
    let rejectAcknowledgement;
    const ui = await renderer({ initialRows: [thread("1"), thread("2")],
      onActionResponse: () => new Promise((_resolve, reject) => { rejectAcknowledgement = reject; }) });
    t.after(() => { rejectAcknowledgement?.(new Error("Synthetic shutdown")); ui.window.events.pagehide(); ui.inbox.close(); });
    const first = ui.ids.get("groups").querySelectorAll(".row-link")[0];
    first.focus();
    const pending = runInContext('markThread("1", "done", true)', ui.context);
    await settle();
    await ui.inbox.batch.done;
    if (moveFocus) ui.ids.get("search").focus();
    await runInContext("update()", ui.context);
    const expected = moveFocus ? ui.ids.get("search") : ui.ids.get("groups").querySelectorAll(".row-link")[0];
    assert.equal(ui.document.activeElement, expected);
    assert.equal(runInContext("marking.size", ui.context), 0);
    rejectAcknowledgement(new Error("Synthetic lost acknowledgement"));
    await pending;
    assert.equal(ui.ids.get("notice").hidden, true);
    assert.equal(ui.document.activeElement, expected);
    assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
  }
});

test("tracking survives failed acknowledgement recovery until a later snapshot identifies the outcome", async t => {
  let release;
  let failState = false;
  const ui = await renderer({ initialRows: [thread("1"), thread("2")],
    onWrite: () => new Promise(resolve => { release = () => resolve("HTTP/2 204 No Content\r\n\r\n"); }),
    onActionResponse: () => { failState = true; throw new Error("Synthetic lost acknowledgement"); },
    onState: () => { if (failState) throw new Error("Synthetic failed recovery"); },
  });
  t.after(() => { release?.(); ui.window.events.pagehide(); ui.inbox.close(); });
  await runInContext('markThread("1", "done")', ui.context);
  await settle();
  assert.equal(runInContext('marking.has("1")', ui.context), true);
  assert.match(ui.ids.get("notice").textContent, /Could not confirm.*Could not reconnect/);
  release();
  await ui.inbox.batch.done;
  failState = false;
  await runInContext("update()", ui.context);
  assert.equal(runInContext("marking.size", ui.context), 0);
  assert.equal(ui.ids.get("notice").hidden, true);
});

test("an unaccepted action stays an explicit failure when filtering hides the row", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  ui.setOffline(true);
  await runInContext('markThread("1", "done")', ui.context);
  assert.equal(runInContext('marking.has("1")', ui.context), true);
  ui.setOffline(false);
  await runInContext('update("filters", { query: "notification 2" })', ui.context);
  assert.equal(runInContext("marking.size", ui.context), 0);
  assert.match(ui.ids.get("notice").textContent, /Could not confirm.*Synthetic connection failure/);
  assert.deepEqual(ui.deletions, []);
});

test("a successful group action clears the old row failure notice without a refresh", async t => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")],
    onWrite: (_path, count) => count === 1 ? http({}, {}, 500) : "HTTP/2 204 No Content\r\n\r\n" });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  await runInContext('markThread("1", "done")', ui.context);
  await finishRows(ui);
  assert.match(ui.ids.get("notice").textContent, /Could not mark.*HTTP 500/);
  ui.advance();
  await runInContext("update()", ui.context);
  await controls(ui).done.events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/1", "/notifications/threads/2"]);
});
