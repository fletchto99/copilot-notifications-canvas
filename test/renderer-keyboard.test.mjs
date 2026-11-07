import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { renderer, settle } from "./renderer-fixtures.mjs";
import { http, thread } from "./fixtures.mjs";

const links = ui => ui.ids.get("groups").querySelectorAll(".row-link");
const control = (ui, key) => ui.ids.get("groups").querySelectorAll("[data-focus-key]").find(node => node.dataset.focusKey === key);
async function press(ui, key, options = {}) {
  let prevented = false;
  await ui.document.events.keydown({
    key, target: ui.document.activeElement, preventDefault: () => { prevented = true; }, ...options,
  });
  return prevented;
}
async function setup(t, options) {
  const ui = await renderer(options);
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  return ui;
}

test("j/k follow rendered order across expanded groups, stop at the ends and never write or load more", async t => {
  for (const groupBy of ["repo", "date", "none"]) {
    const ui = await setup(t, { storedSettings: { groupBy }, initialRows: [
      thread("1", { updated_at: "2026-01-09T12:00:00Z" }),
      thread("2", { repository: { full_name: "example/other" }, updated_at: "2026-01-10T12:00:00Z" }),
      thread("3", { updated_at: "2026-01-10T12:00:00Z" }),
    ] });
    const rows = links(ui);
    for (const link of rows) {
      assert.equal(await press(ui, "j"), true);
      assert.equal(ui.document.activeElement, link);
      assert.deepEqual({ ...link.lastScroll }, { block: "nearest", inline: "nearest" });
    }
    await press(ui, "j", { repeat: true });
    assert.equal(ui.document.activeElement, rows.at(-1));
    for (const link of rows.slice(0, -1).reverse()) {
      await press(ui, "k", { repeat: true });
      assert.equal(ui.document.activeElement, link);
    }
    await press(ui, "k");
    assert.equal(ui.document.activeElement, rows[0]);
    ui.ids.get("collapse").focus();
    await press(ui, "k");
    assert.equal(ui.document.activeElement, rows.at(-1));
    if (groupBy !== "none") {
      const firstGroup = ui.ids.get("groups").querySelectorAll(".repo-toggle")[0];
      await firstGroup.events.click();
      ui.ids.get("collapse").focus();
      await press(ui, "j");
      assert.equal(ui.document.activeElement, links(ui).find(link => !link.closest(".repo-items").hidden));
    }
    ui.ids.get("collapse").focus();
    await ui.ids.get("collapse").events.click();
    assert.equal(await press(ui, "j"), false);
    assert.equal(await press(ui, "k"), false);
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
    assert.equal(ui.calls.some(call => call.path === "/api/more"), false);
  }
});

test("row button focus anchors navigation and live filtered results replace the navigation scope", async t => {
  const ui = await setup(t, { initialRows: [thread("1"), thread("2"), thread("3")] });
  control(ui, "read:1").focus();
  await press(ui, "j");
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:2");
  await runInContext('update("filters", { query: "notification 3" })', ui.context);
  assert.equal(links(ui).length, 1);
  ui.ids.get("collapse").focus();
  await press(ui, "j");
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:3");
  await runInContext('update("filters", { query: "no match" })', ui.context);
  assert.equal(await press(ui, "j"), false);
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("shortcuts ignore editable descendants, modifiers, composition, inactive panels and Settings", async t => {
  const ui = await setup(t);
  const shortcuts = [["j", {}], ["k", {}], ["/", {}], ["?", {}], ["i", {}], ["E", { shiftKey: true }]];
  const ignored = [
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true },
  ];
  for (const [key, options] of shortcuts) {
    for (const extra of ignored) {
      links(ui)[0].focus();
      assert.equal(await press(ui, key, { ...options, ...extra }), false);
      assert.equal(ui.document.activeElement, links(ui)[0]);
    }
    for (const tag of ["input", "textarea", "select", "option", "div", "span"]) {
      const parent = ui.document.createElement(tag === "option" ? "select" : tag);
      if (tag === "div") parent.setAttribute("contenteditable", "true");
      if (tag === "span") parent.setAttribute("role", "textbox");
      const child = ui.document.createElement("span");
      parent.append(child);
      assert.equal(await press(ui, key, { ...options, target: child }), false);
    }
    ui.ids.get("settings").open = true;
    assert.equal(await press(ui, key, options), false);
    ui.ids.get("settings").open = false;
    ui.setDocumentFocused(false);
    assert.equal(await press(ui, key, options), false);
    ui.setDocumentFocused(true);
    ui.document.hidden = true;
    assert.equal(await press(ui, key, options), false);
    ui.document.hidden = false;
    ui.intersect(false);
    assert.equal(await press(ui, key, options), false);
    ui.intersect(true);
    await settle();
  }
  for (const key of ["j", "k", "i", "I"]) assert.equal(await press(ui, key, { shiftKey: true }), false);
  assert.equal(await press(ui, "I"), false);
  for (const key of ["e", "E"]) assert.equal(await press(ui, key), false);
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("search and help shortcuts preserve text, trap actions in the guide and restore replaced row focus", async t => {
  const ui = await setup(t, { initialRows: [thread("1"), thread("2")] });
  links(ui)[0].focus();
  assert.equal(await press(ui, "/", { shiftKey: true }), true);
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
  ui.ids.get("search").value = "draft search";
  assert.equal(await press(ui, "/"), false);
  assert.equal(ui.ids.get("search").value, "draft search");
  ui.ids.get("search").disabled = true;
  links(ui)[0].focus();
  assert.equal(await press(ui, "/"), false);
  ui.ids.get("search").disabled = false;
  assert.equal(await press(ui, "?", { repeat: true }), true);
  assert.ok(!ui.ids.get("shortcuts-dialog").open);
  assert.equal(await press(ui, "?", { shiftKey: true }), true);
  assert.equal(ui.ids.get("shortcuts-dialog").open, true);
  assert.equal(ui.document.activeElement, ui.ids.get("shortcuts-close"));
  for (const key of ["j", "/", "i", "?"]) assert.equal(await press(ui, key), false);
  assert.equal(await press(ui, "E", { shiftKey: true }), false);
  ui.inbox.pages[0].items[0].title = "Updated synthetic title";
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement, ui.ids.get("shortcuts-close"));
  await press(ui, "Escape");
  assert.equal(ui.ids.get("shortcuts-dialog").open, false);
  assert.equal(ui.document.activeElement, links(ui)[0]);
  links(ui)[0].focus();
  ui.ids.get("shortcuts-toggle").events.click();
  ui.ids.get("shortcuts-toggle").events.click();
  ui.ids.get("shortcuts-close").events.click();
  assert.equal(ui.document.activeElement, ui.ids.get("shortcuts-toggle"));
  links(ui)[0].focus();
  await press(ui, "?");
  ui.inbox.onThreadUpdated("1", "done");
  await runInContext("update()", ui.context);
  ui.ids.get("shortcuts-close").events.click();
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("i reads only the focused unread row and Shift+E completes only the focused row in every view", async t => {
  for (const groupBy of ["repo", "date", "none"]) {
    for (const matchGitHubInbox of [true, false]) {
      const ui = await setup(t, { storedSettings: { groupBy, matchGitHubInbox }, initialRows: [thread("1"), thread("2")] });
      assert.equal(await press(ui, "E", { shiftKey: true }), false);
      await press(ui, "j");
      for (const key of ["e", "E"]) assert.equal(await press(ui, key), false);
      assert.equal(await press(ui, "I", { shiftKey: true }), false);
      assert.deepEqual(ui.patches, []);
      assert.deepEqual(ui.deletions, []);
      await press(ui, "i");
      assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
      assert.equal(ui.document.activeElement.dataset.focusKey, "thread:2");
      assert.equal(await press(ui, "i", { repeat: true }), true);
      if (matchGitHubInbox) {
        control(ui, "thread:1").focus();
        await press(ui, "i");
        control(ui, "thread:2").focus();
      }
      assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
      await press(ui, "E", { shiftKey: true });
      assert.deepEqual(ui.deletions, ["/notifications/threads/2"]);
      if (matchGitHubInbox) {
        assert.equal(ui.document.activeElement.dataset.focusKey, "thread:1");
        await press(ui, "E", { shiftKey: true, repeat: true });
        assert.equal(ui.deletions.length, 1);
        await press(ui, "E", { shiftKey: true });
      }
      assert.equal(ui.document.activeElement, ui.ids.get("search"));
      assert.equal(links(ui).length, 0);
    }
  }
});

test("Read shortcuts advance across expanded groups and stop on the last retained row without wrapping", async t => {
  const ui = await setup(t, { initialRows: [
    thread("1"), thread("2", { repository: { full_name: "example/hidden" } }),
    thread("3", { repository: { full_name: "example/last" } }),
    thread("4", { repository: { full_name: "example/last" } }),
  ] });
  await ui.ids.get("groups").querySelectorAll(".repo-toggle")[1].events.click();
  control(ui, "read:1").focus();
  await press(ui, "i");
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:3");
  await press(ui, "i");
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:4");
  await press(ui, "i");
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:4");
  assert.deepEqual(ui.patches, ["/notifications/threads/1", "/notifications/threads/3", "/notifications/threads/4"]);
  assert.equal(links(ui).length, 4);
  assert.deepEqual(ui.deletions, []);
});

test("Read auto-advance does not steal focus moved during the write", async t => {
  let finish;
  const ui = await setup(t, { initialRows: [thread("1"), thread("2"), thread("3")],
    onWrite: () => new Promise(resolve => { finish = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); }) });
  control(ui, "thread:1").focus();
  const pending = press(ui, "i");
  await settle();
  control(ui, "thread:3").focus();
  finish();
  await pending;
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:3");
  assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
});

test("shortcut actions skip collapsed groups when choosing the next link and can start from row buttons", async t => {
  const ui = await setup(t, { initialRows: [
    thread("1"), thread("2", { repository: { full_name: "example/hidden" } }),
    thread("3", { repository: { full_name: "example/last" } }),
  ] });
  await ui.ids.get("groups").querySelectorAll(".repo-toggle")[1].events.click();
  control(ui, "done:1").focus();
  await press(ui, "E", { shiftKey: true });
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:3");
  await press(ui, "E", { shiftKey: true });
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
  assert.deepEqual(ui.deletions, ["/notifications/threads/1", "/notifications/threads/3"]);
});

test("pending writes allow other rows' shortcuts and completion does not steal newer focus", async t => {
  let finish;
  const ui = await setup(t, { initialRows: [thread("1"), thread("2"), thread("3")],
    onWrite: (_path, count) => count === 1
      ? new Promise(resolve => { finish = () => resolve("HTTP/2 204 No Content\r\n\r\n"); })
      : "HTTP/2 205 Reset Content\r\n\r\n" });
  await press(ui, "j");
  const pending = press(ui, "E", { shiftKey: true });
  await settle();
  await press(ui, "j");
  const second = press(ui, "i");
  await press(ui, "E", { shiftKey: true });
  assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
  assert.deepEqual(ui.patches, []);
  await press(ui, "j");
  finish();
  await Promise.all([pending, second]);
  assert.deepEqual(ui.patches, ["/notifications/threads/2"]);
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:3");
  await press(ui, "/");
  ui.ids.get("search").value = "notification 2";
  ui.ids.get("search").events.input();
  control(ui, "thread:3").focus();
  await press(ui, "E", { shiftKey: true });
  assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
});

test("failed keyboard actions keep focus and expose the existing error without automatic retries", async t => {
  for (const [action, key, options] of [["read", "i", {}], ["done", "E", { shiftKey: true }]]) {
    const ui = await setup(t, { initialRows: [thread("1"), thread("2")], onWrite: () => http({}, {}, 500) });
    await press(ui, "j");
    await press(ui, key, options);
    assert.equal(ui.document.activeElement.dataset.focusKey, "thread:1");
    assert.match(ui.ids.get("notice").textContent, new RegExp(`Could not mark the notification as ${action}.*HTTP 500`));
    await press(ui, key, { ...options, repeat: true });
    await ui.fireTimer();
    assert.deepEqual(action === "read" ? ui.patches : ui.deletions, ["/notifications/threads/1"]);
  }
});

test("Enter in search focuses the first expanded result, independent of character shortcuts, without opening it", async t => {
  for (const keyboardShortcuts of [true, false]) {
    const ui = await setup(t, { storedSettings: { keyboardShortcuts }, initialRows: [
      thread("1"), thread("2", { repository: { full_name: "example/second" } }),
    ] });
    await ui.ids.get("groups").querySelectorAll(".repo-toggle")[0].events.click();
    const search = ui.ids.get("search");
    search.focus();
    assert.equal(await press(ui, "Enter"), true);
    assert.equal(ui.document.activeElement.dataset.focusKey, "thread:2");
    assert.equal(search.value, "");
    assert.equal(await press(ui, "Enter", { repeat: true }), true);
    ui.document.events.keyup({ key: "Enter" });
    assert.equal(await press(ui, "Enter"), false);
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  }
});

test("search Enter flushes its debounce and focuses only the settled matching row", async t => {
  const ui = await setup(t, { initialRows: [thread("1"), thread("2")] });
  const search = ui.ids.get("search");
  search.focus();
  search.value = "notification 2";
  search.events.input();
  await press(ui, "Enter");
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:2");
  assert.equal(search.value, "notification 2");
  assert.equal([...ui.timers.values()].some(timer => timer.delay === 250), false);
  assert.equal(ui.calls.filter(call => call.path === "/api/filters").length, 1);
  search.focus();
  search.value = "discarded edit";
  search.events.input();
  search.value = "notification 2";
  search.events.input();
  await press(ui, "Enter");
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:2");
  assert.equal(ui.calls.filter(call => call.path === "/api/filters").length, 1);
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("Enter during an in-flight filter waits, and newer input or focus changes cancel the handoff", async t => {
  for (const cancel of ["none", "input", "blur", "window", "pointer", "key", "hidden"]) {
    let finish;
    const ui = await setup(t, { initialRows: [thread("1"), thread("2")],
      onFilters: () => new Promise(resolve => { finish = resolve; }) });
    const search = ui.ids.get("search");
    search.focus();
    search.value = "notification 2";
    search.events.input();
    const filtering = ui.fireTimer(250);
    await settle();
    await press(ui, "Enter");
    assert.equal(ui.document.activeElement, search);
    if (cancel === "input") search.events.input();
    if (cancel === "blur") {
      search.events.blur();
      ui.ids.get("force-refresh").focus();
      search.focus();
    }
    if (cancel === "window") ui.window.events.blur();
    if (cancel === "pointer") ui.document.events.pointerdown();
    if (cancel === "key") await press(ui, "ArrowLeft");
    if (cancel === "hidden") ui.intersect(false);
    finish();
    await filtering;
    assert.equal(ui.document.activeElement, cancel === "none" ? control(ui, "thread:2") : search, cancel);
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  }
});

test("search Enter also waits for an existing poll before choosing the first row", async t => {
  let finish;
  const ui = await setup(t, { initialRows: [thread("1"), thread("2")],
    onState: () => new Promise(resolve => { finish = resolve; }) });
  const polling = ui.fireTimer();
  await settle();
  ui.ids.get("search").focus();
  await press(ui, "Enter");
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
  finish();
  await polling;
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:1");
});

test("failed filters cancel search Enter without moving focus after a background retry", async t => {
  let fail = true;
  const ui = await setup(t, { initialRows: [thread("1"), thread("2")], onFilters: () => {
    if (fail) throw new Error("Synthetic filter failure");
  } });
  const search = ui.ids.get("search");
  search.focus();
  search.value = "notification 2";
  search.events.input();
  await press(ui, "Enter");
  assert.equal(ui.document.activeElement, search);
  assert.match(ui.ids.get("notice").textContent, /Synthetic filter failure/);
  fail = false;
  await ui.fireTimer();
  assert.equal(ui.document.activeElement, search);
  await press(ui, "Enter");
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:2");
});

test("search Enter ignores composition, modifiers and unavailable controls", async t => {
  const ui = await setup(t);
  const search = ui.ids.get("search");
  search.focus();
  for (const options of [
    { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true },
    { altKey: true }, { shiftKey: true }, { defaultPrevented: true },
  ]) {
    assert.equal(await press(ui, "Enter", options), false);
    assert.equal(ui.document.activeElement, search);
  }
  search.events.compositionstart();
  assert.equal(await press(ui, "Enter"), false);
  search.events.compositionend();
  search.disabled = true;
  assert.equal(await press(ui, "Enter", { target: search }), false);
  search.disabled = false;
  search.focus();
  ui.setDocumentFocused(false);
  assert.equal(await press(ui, "Enter"), false);
  ui.setDocumentFocused(true);
  ui.intersect(false);
  assert.equal(await press(ui, "Enter"), false);
});

test("no-match and collapsed results leave search focused without deferring a later surprise move", async t => {
  const ui = await setup(t);
  const search = ui.ids.get("search");
  search.focus();
  search.value = "no match";
  search.events.input();
  await press(ui, "Enter");
  assert.equal(ui.document.activeElement, search);
  search.value = "";
  search.events.input();
  await ui.fireTimer(250);
  assert.equal(ui.document.activeElement, search);
  await ui.ids.get("collapse").events.click();
  await press(ui, "Enter");
  assert.equal(ui.document.activeElement, search);
  await ui.ids.get("collapse").events.click();
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement, search);
});

test("the persisted shortcut switch disables character shortcuts and ARIA hints and hides the help button", async t => {
  const storedSettings = {};
  const ui = await setup(t, { storedSettings });
  const toggle = ui.ids.get("keyboard-shortcuts");
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(ui.ids.get("shortcuts-control").hidden, false);
  assert.equal(ui.ids.get("groups").getAttribute("aria-keyshortcuts"), "j k");
  assert.equal(control(ui, "read:1").getAttribute("aria-keyshortcuts"), "i");
  assert.equal(control(ui, "done:1").getAttribute("aria-keyshortcuts"), "Shift+e");
  for (const enabled of [false, true]) {
    await toggle.events.click();
    await settle();
    assert.equal(toggle.getAttribute("aria-checked"), String(enabled));
    assert.equal(storedSettings.keyboardShortcuts, enabled);
    assert.equal(ui.ids.get("shortcuts-control").hidden, !enabled);
    assert.equal(ui.ids.get("search").getAttribute("aria-keyshortcuts"), enabled ? "/" : null);
    links(ui)[0].focus();
    for (const key of ["j", "k", "/", "?"]) {
      if (!enabled) assert.equal(await press(ui, key), false);
    }
    if (!enabled) {
      await press(ui, "E", { shiftKey: true });
      await press(ui, "i");
    }
  }
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
  const reopened = await setup(t, { storedSettings: { keyboardShortcuts: false } });
  assert.equal(reopened.ids.get("keyboard-shortcuts").getAttribute("aria-checked"), "false");
  assert.equal(await press(reopened, "j"), false);
  assert.equal(reopened.ids.get("shortcuts-control").hidden, true);
  assert.ok(!reopened.ids.get("shortcuts-dialog").open);
});

test("a failed preference load or save does not silently enable shortcuts or discard the last choice", async t => {
  let fail = true;
  const ui = await setup(t, { storedSettings: { keyboardShortcuts: false }, onSettings: () => {
    if (fail) throw new Error("Synthetic settings failure");
  } });
  assert.equal(await press(ui, "j"), false);
  assert.equal(ui.ids.get("keyboard-shortcuts").disabled, true);
  fail = false;
  await runInContext("settingsRequest()", ui.context);
  fail = true;
  ui.ids.get("keyboard-shortcuts").events.click();
  await settle();
  assert.equal(ui.ids.get("keyboard-shortcuts").getAttribute("aria-checked"), "false");
  assert.match(ui.ids.get("settings-error").textContent, /Synthetic settings failure/);
  assert.equal(await press(ui, "j"), false);
});
