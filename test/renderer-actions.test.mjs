import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { http, thread } from "./fixtures.mjs";
import { renderer, script, html, styles, settle } from "./renderer-fixtures.mjs";

test("mark-read requires a click and removes only on confirmation", async () => {
  const ui = await renderer();
  assert.equal(ui.calls.some(call => call.path === "/api/read"), false);
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  assert.match(button.attributes["aria-label"], /Mark as read/);
  button.focus();
  const marking = button.events.click();
  assert.equal(button.disabled, true);
  await button.events.click();
  await marking;
  assert.equal(ui.calls.filter(call => call.path === "/api/read").length, 1);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
  ui.window.events.pagehide();
});

test("row reads focus the next row whether disabling a button blurs it immediately or retains focus", async () => {
  for (const retainDisabledFocus of [false, true]) {
    const ui = await renderer({ retainDisabledFocus, initialRows: [
      thread("1", { updated_at: "2026-01-11T12:00:00Z" }),
      thread("2"),
    ] });
    const readButton = id => ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === id);
    const first = readButton("1");
    first.focus();
    await first.events.click();
    assert.equal(ui.document.activeElement, readButton("2"));
    assert.equal(ui.ids.get("search").value, "");
    ui.window.events.pagehide();
  }
});

test("row reads fall back to Search when the next row belongs to a collapsed group", async t => {
  for (const groupBy of ["repo", "date"]) {
    for (const retainDisabledFocus of [false, true]) {
      const ui = await renderer({ retainDisabledFocus, storedSettings: { groupBy }, initialRows: [
        thread("1", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-11T12:00:00Z" }),
        thread("2", { repository: { full_name: "example/zulu" } }),
      ] });
      t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
      const buttons = () => ui.ids.get("groups").querySelectorAll("button");
      buttons().filter(node => node.dataset.disclosure)[1].events.click();
      const first = buttons().find(node => node.dataset.threadId === "1");
      first.focus();
      await first.events.click();
      assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
      assert.equal(ui.document.activeElement, ui.ids.get("search"));
      assert.equal(buttons().find(node => node.dataset.disclosure).attributes["aria-expanded"], "false");
      assert.equal(ui.ids.get("groups").children[0].children[1].hidden, true);
    }
  }
});

test("a row read never steals focus moved to Search while the write is pending", async () => {
  let release;
  const ui = await renderer({ retainDisabledFocus: true, initialRows: [thread("1"), thread("2")],
    onWrite: () => new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); }) });
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  button.focus();
  const marking = button.events.click();
  await settle();
  ui.ids.get("search").focus();
  release();
  await marking;
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
  ui.window.events.pagehide();
});

test("mark-read keeps repository groups alphabetical as their newest and last notifications disappear", async () => {
  const ui = await renderer({ initialRows: [
    thread("1", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-30T00:00:00Z" }),
    thread("2", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-01T00:00:00Z" }),
    thread("3", { repository: { full_name: "example/middle" }, updated_at: "2026-01-20T00:00:00Z" }),
    thread("4", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-10T00:00:00Z" }),
  ] });
  const repositories = () => ui.ids.get("groups").querySelectorAll("button")
    .filter(node => node.dataset.repository).map(node => node.dataset.repository);
  assert.deepEqual(repositories(), ["example/alpha", "example/middle", "example/zulu"]);

  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1").events.click();
  assert.deepEqual(repositories(), ["example/alpha", "example/middle", "example/zulu"]);
  assert.equal(ui.document.querySelectorAll("article").length, 3);

  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "2").events.click();
  assert.deepEqual(repositories(), ["example/middle", "example/zulu"]);
  assert.equal(ui.document.querySelectorAll("article").length, 2);
  ui.window.events.pagehide();
});

test("mark-read failure retains the row with a usable retry control", async () => {
  const ui = await renderer({ readFailure: true });
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  await button.events.click();
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal(button.disabled, false);
  assert.match(ui.ids.get("notice").textContent, /Could not mark/);
});

test("repository header shares its hover background across the toggle and read action", async () => {
  const ui = await renderer();
  const buttons = ui.ids.get("groups").querySelectorAll("button");
  const disclosure = buttons.find(node => node.dataset.disclosure);
  const groupRead = buttons.find(node => node.dataset.focusKey === "bulk:example/widgets");
  assert.equal(disclosure.className, "repo-toggle");
  assert.equal(disclosure.parentNode.className, "repo-header");
  assert.equal(groupRead.parentNode, disclosure.parentNode);
  assert.match(styles, /button:hover:not\(:disabled, \.repo-toggle\), summary:hover, \.icon-button:hover, \.repo-header:hover, \.row:hover \{\s*background: color-mix\(in srgb, var\(--canvas-text\) 4%, transparent\);/);
  assert.match(styles, /@media \(prefers-reduced-motion: no-preference\) \{\s*button, a, \.repo-header \{ transition: background-color \.12s ease; \}/);
  ui.window.events.pagehide();
});

test("repository toggle focus is inset inside the clipped card", () => {
  assert.match(styles, /:focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: 3px; \}/);
  assert.match(styles, /\.repo-group \{[^}]*overflow: clip;/);
  assert.match(styles, /\.repo-toggle:focus-visible \{ outline-offset: -5px; \}/);
});

test("compact toolbar keeps a shrinkable search beside matching inbox, refresh and settings icons", () => {
  assert.match(styles, /\.toolbar \{ display: flex;[^}]*\}/);
  assert.match(styles, /\.search \{ flex: 1; min-width: 0; \}/);
  assert.match(styles, /\.icon-button \{[^}]*flex-shrink: 0;[^}]*width: 38px; height: 38px;[^}]*color: var\(--canvas-text\);/);
  assert.match(styles, /\.settings \{[^}]*flex-shrink: 0;/);
  assert.doesNotMatch(styles, /\.toolbar \{[^}]*flex-wrap: wrap/);
  assert.doesNotMatch(styles, /\.search \{[^}]*flex-basis: 100%/);
});

test("notification metadata, counts and read actions use 12px text", () => {
  for (const selector of ["\\.metadata", "time", "\\.repo-count", "\\.repo-read", "\\.mark-read"]) {
    const rule = styles.match(new RegExp(`(?:^|\\n)${selector} \\{[^}]*\\}`))?.[0] ?? "";
    assert.match(rule, /font-size: 12px;/, selector);
  }
});

test("toolbar force refresh preserves the native notification toggle and selected sound", async () => {
  const storedSettings = { autoOpen: true, darkMode: true, desktopNotifications: true, desktopSound: "Submarine" };
  const ui = await renderer({ storedSettings });
  await ui.ids.get("force-refresh").events.click();
  assert.equal(ui.githubCalls.length, 2);
  assert.equal(ui.ids.get("desktop-notifications").attributes["aria-checked"], "true");
  assert.equal(ui.ids.get("desktop-sound").value, "Submarine");
  assert.equal(ui.ids.get("desktop-sound").disabled, false);
  assert.deepEqual(storedSettings, { autoOpen: true, darkMode: true, desktopNotifications: true, desktopSound: "Submarine" });
  assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
});

test("repository action starts from one click with no dialog and preserves independent disclosure", async () => {
  let release;
  const ui = await renderer({
    onWrite: () => new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); }),
  });
  const buttons = ui.ids.get("groups").querySelectorAll("button");
  const disclosure = buttons.find(node => node.dataset.disclosure);
  const groupRead = buttons.find(node => node.dataset.focusKey === "bulk:example/widgets");
  assert.match(groupRead.textContent, /Mark 1 as read/);
  assert.equal(disclosure.contains(groupRead), false);
  assert.equal(groupRead.contains(disclosure), false);
  disclosure.events.click();
  groupRead.focus();
  await groupRead.events.click();
  await settle();
  assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
  assert.deepEqual(ui.calls.filter(call => call.path.startsWith("/api/batch/")).map(call => call.path), ["/api/batch/start"]);
  assert.equal(ui.document.activeElement, ui.ids.get("batch-stop"));
  assert.equal(disclosure.attributes["aria-expanded"], "false");
  assert.match(groupRead.textContent, /Marking 0\/1/);
  assert.equal(groupRead.attributes["aria-busy"], "true");
  assert.doesNotMatch(html, /<dialog|batch-confirm|batch-start|batch-cancel/);
  assert.doesNotMatch(script, /showModal|batch\/prepare|Repository action finished/);
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.ids.get("batch-title").textContent, "");
  assert.equal(ui.ids.get("batch-counts").textContent, "");
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
});

test("one-click repository read honors search, blocks duplicate clicks and quietly clears successful rows", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2")],
    onWrite: () => new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); }),
  });
  await runInContext('update("filters", { query: "notification 1" })', ui.context);
  const groupRead = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.focusKey.startsWith("bulk:"));
  assert.equal(groupRead.textContent, "Mark 1 as read");
  groupRead.focus();
  const first = groupRead.events.click();
  await groupRead.events.click();
  await first;
  assert.equal(ui.ids.get("search").disabled, true);
  assert.equal(ui.inbox.batch.snapshot().total, 1);
  assert.equal(ui.inbox.batch.snapshot().searchActive, true);
  assert.equal(ui.document.activeElement, ui.ids.get("batch-stop"));
  await settle();
  await runInContext("update()", ui.context);
  assert.match(groupRead.textContent, /Marking 0\/1/);
  assert.equal(ui.ids.has("refresh"), false);
  assert.equal(ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1").disabled, true);
  release();
  await ui.inbox.batch.done;
  await runInContext("tick()", ui.context);
  assert.equal(ui.inbox.batch.snapshot(), null);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("batch-counts").textContent, "");
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
  assert.equal(ui.inbox.summary().loaded, 1);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
  ui.window.events.pagehide();
});

test("partial batch progress shows retryable remaining counts without repeating successes or expanding selection", async () => {
  let failures = true;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2"), thread("3")],
    onWrite: (_path, count) => count === 2 && failures ? http({}, {}, 500) : "HTTP/2 205 Reset Content\r\n\r\n",
  });
  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.focusKey.startsWith("bulk:")).events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.match(ui.ids.get("batch-counts").textContent, /1 succeeded \/ 1 failed \/ 0 skipped \/ 1 not attempted/);
  assert.equal(ui.ids.get("batch-retry").hidden, false);
  assert.equal(ui.ids.get("batch-retry").textContent, "Retry remaining (2)");
  assert.equal(ui.ids.get("batch-retry").disabled, true);
  assert.match(ui.ids.get("batch-error").textContent, /HTTP 500/);
  failures = false;
  ui.advance();
  ui.inbox.client.blockedUntil = 0;
  await runInContext("update()", ui.context);
  ui.ids.get("batch-retry").focus();
  await ui.ids.get("batch-retry").events.click();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.deepEqual(ui.patches, ["/notifications/threads/1", "/notifications/threads/2", "/notifications/threads/2", "/notifications/threads/3"]);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("batch-counts").textContent, "");
  assert.equal(ui.ids.get("batch-error").textContent, "");
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
});

test("batch failure to reconnect is visible and never silently retries a mutation", async () => {
  const ui = await renderer();
  ui.setOffline(true);
  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.focusKey.startsWith("bulk:")).events.click();
  assert.equal(ui.ids.has("batch-confirm"), false);
  assert.match(ui.ids.get("notice").textContent, /Synthetic connection failure/);
  assert.equal(ui.patches.length, 0);
});

test("a group changed before the click is accepted reloads its count instead of marking a wider selection", async () => {
  const ui = await renderer();
  const oldButton = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository);
  assert.equal(oldButton.textContent, "Mark 1 as read");
  ui.inbox.pages[0].items.push({ ...ui.inbox.pages[0].items[0], id: "3", title: "Synthetic newcomer" });
  await oldButton.events.click();
  assert.deepEqual(ui.patches, []);
  assert.match(ui.ids.get("notice").textContent, /shown group changed/);
  const currentButton = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository);
  assert.equal(currentButton.textContent, "Mark 2 as read");
  assert.equal(currentButton.disabled, false);
});

test("stop remains usable during a long batch and the final successful request clears its controls quietly", async () => {
  let release;
  const ui = await renderer({
    onWrite: () => new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); }),
  });
  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository).events.click();
  await settle();
  assert.equal(ui.ids.get("batch-stop").hidden, false);
  ui.ids.get("batch-stop").focus();
  await ui.ids.get("batch-stop").events.click();
  assert.equal(ui.inbox.batch.snapshot().status, "stopping");
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("batch-title").textContent, "");
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
});

test("local status polling preserves keyboard focus on row and repository read controls", async () => {
  const ui = await renderer();
  for (const key of ["read:1", "bulk:example/widgets"]) {
    const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.focusKey === key);
    button.focus();
    assert.equal(ui.document.activeElement, button);
    await ui.fireTimer();
    assert.equal(ui.calls.at(-1).path, "/api/state");
    assert.equal(button.disabled, false);
    assert.equal(ui.document.activeElement, button);
  }
});

test("a row action clicked during a delayed local poll runs after the poll instead of being dropped", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2")],
    onState: () => new Promise(resolve => { release = resolve; }),
  });
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  button.focus();
  const polling = ui.fireTimer();
  await settle();
  assert.equal(button.disabled, false);
  assert.equal(ui.document.activeElement, button);
  const reading = button.events.click();
  await button.events.click();
  assert.equal(button.disabled, true);
  assert.equal(ui.document.activeElement, ui.document.body);
  assert.deepEqual(ui.patches, []);
  release();
  await polling;
  await reading;
  assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal(ui.document.activeElement.dataset.focusKey, "read:2");
  assert.equal(ui.document.activeElement.disabled, false);
});

test("a repository action clicked during local polling is not dropped and cannot receive a stale poll response afterward", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2")],
    onState: () => new Promise(resolve => { release = resolve; }),
  });
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository);
  button.focus();
  const polling = ui.fireTimer();
  await settle();
  assert.equal(button.disabled, false);
  const reading = button.events.click();
  assert.deepEqual(ui.patches, []);
  release();
  await polling;
  await reading;
  await ui.inbox.batch.done;
  const finalPoll = runInContext("update()", ui.context);
  await settle();
  release();
  await finalPoll;
  assert.deepEqual(ui.patches, ["/notifications/threads/1", "/notifications/threads/2"]);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("notice").hidden, true);
});

test("search edits during a row write are preserved on success and failure, with the latest edit winning", async () => {
  for (const success of [true, false]) {
    let release;
    const ui = await renderer({
      initialRows: [thread("1"), thread("2"), thread("3")],
      onWrite: () => new Promise(resolve => { release = () => resolve(success ? "HTTP/2 205 Reset Content\r\n\r\n" : http({}, {}, 403)); }),
    });
    const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
    const reading = button.events.click();
    await settle();
    const search = ui.ids.get("search");
    search.focus();
    search.value = "notification 2";
    search.events.input();
    await ui.fireTimer(250);
    search.value = "notification 3";
    search.events.input();
    release();
    await reading;
    await settle();
    assert.equal(search.value, "notification 3");
    assert.equal(ui.inbox.filters.query, "notification 3");
    assert.equal(ui.document.querySelectorAll("article").length, 1);
    assert.equal(ui.document.querySelectorAll("a")[0].textContent, "Synthetic notification 3");
    assert.deepEqual(ui.calls.filter(call => call.path === "/api/filters").map(call => JSON.parse(call.options.body).query), ["notification 3"]);
    assert.equal(ui.document.activeElement, search);
    assert.equal(ui.ids.get("notice").hidden, success);
  }
});

test("a search debounce already pending before a read is flushed after the read", async () => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  const search = ui.ids.get("search");
  search.value = "notification 2";
  search.events.input();
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  await button.events.click();
  await settle();
  assert.equal(ui.inbox.filters.query, "notification 2");
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal([...ui.timers.values()].some(timer => timer.delay === 250), false);
});

test("pending search is retained while a repository batch runs", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2", { repository: { full_name: "example/other" } })],
    onWrite: () => new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); }),
  });
  const search = ui.ids.get("search");
  search.value = "other";
  search.events.input();
  const group = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository === "example/widgets");
  await group.events.click();
  await settle();
  await ui.fireTimer(250);
  assert.equal(search.disabled, true);
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  await settle();
  assert.equal(search.disabled, false);
  assert.equal(search.value, "other");
  assert.equal(ui.inbox.filters.query, "other");
  assert.equal(ui.document.querySelectorAll("article").length, 1);
});

test("newer queued queries replace older edits while waiting for a local poll", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2"), thread("3")],
    onState: () => new Promise(resolve => { release = resolve; }),
  });
  const polling = ui.fireTimer();
  await settle();
  const filtering = runInContext('update("filters", { query: "notification 2" })', ui.context);
  const search = ui.ids.get("search");
  search.value = "notification 3";
  search.events.input();
  release();
  await polling;
  await filtering;
  assert.deepEqual(ui.calls.filter(call => call.path === "/api/filters").map(call => JSON.parse(call.options.body).query), ["notification 3"]);
  assert.equal(ui.inbox.filters.query, "notification 3");
});

test("rapid edits during an in-flight filter cannot apply an older query after a newer one", async () => {
  let release;
  let filtered = 0;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2"), thread("3")],
    onFilters: async () => {
      if (++filtered === 1) await new Promise(resolve => { release = resolve; });
    },
  });
  const filtering = runInContext('update("filters", { query: "notification 1" })', ui.context);
  await settle();
  const search = ui.ids.get("search");
  search.focus();
  search.value = "notification 2";
  search.events.input();
  search.value = "notification 3";
  search.events.input();
  release();
  await filtering;
  await settle();
  assert.deepEqual(ui.calls.filter(call => call.path === "/api/filters").map(call => JSON.parse(call.options.body).query),
    ["notification 1", "notification 3"]);
  assert.equal(ui.inbox.filters.query, "notification 3");
});

test("necessary disables restore focus after success or failure without stealing a user's new focus", async () => {
  for (const moveFocus of [false, true]) {
    let release;
    let requests = 0;
    const ui = await renderer({ onFetch: () => ++requests === 1 ? http([thread()]) :
      new Promise(resolve => { release = () => resolve(http([thread()])); }) });
    const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
    button.focus();
    ui.advance();
    const refreshing = ui.fireTimer();
    await settle();
    assert.equal(button.disabled, true);
    assert.equal(ui.document.activeElement, ui.document.body);
    if (moveFocus) ui.ids.get("search").focus();
    release();
    await refreshing;
    assert.equal(button.disabled, false);
    assert.equal(ui.document.activeElement, moveFocus ? ui.ids.get("search") : button);
  }
  const failed = await renderer({ readFailure: true });
  const button = failed.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  button.focus();
  await button.events.click();
  assert.equal(button.disabled, false);
  assert.equal(failed.document.activeElement, button);
});

test("a failed filter request retains the latest text and retries on a later local poll", async () => {
  let fail = true;
  const ui = await renderer({ initialRows: [thread("1"), thread("2")], onFilters: async () => {
    if (fail) throw new Error("Synthetic filter connection failure");
  } });
  const search = ui.ids.get("search");
  search.focus();
  search.value = "notification 2";
  search.events.input();
  await ui.fireTimer(250);
  assert.equal(ui.inbox.filters.query, "");
  assert.equal(search.value, "notification 2");
  assert.equal(ui.ids.get("notice").hidden, false);
  fail = false;
  await ui.fireTimer();
  assert.equal(ui.inbox.filters.query, "notification 2");
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal(ui.document.activeElement, search);
});

test("a queued filter survives becoming hidden before a local poll settles", async () => {
  let release;
  let hold = true;
  const ui = await renderer({ onState: async () => {
    if (hold) await new Promise(resolve => { release = resolve; });
  } });
  const polling = ui.fireTimer();
  await settle();
  const filtering = runInContext('update("filters", { query: "no match" })', ui.context);
  ui.intersect(false);
  release();
  await polling;
  await filtering;
  assert.equal(ui.inbox.filters.query, "");
  hold = false;
  ui.intersect(true);
  await settle();
  assert.equal(ui.inbox.filters.query, "no match");
  assert.equal(ui.document.querySelectorAll("article").length, 0);
});
