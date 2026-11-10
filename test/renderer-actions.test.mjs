import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { http, thread } from "./fixtures.mjs";
import { disabled, finishRows, groupActionText, groupProgress, renderer, script, html, styles, settle } from "./renderer-fixtures.mjs";

test("row actions use distinct decorative SVGs with accessible names and shared tooltip behavior", async t => {
  const ui = await renderer();
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const paths = [];
  for (const action of ["read", "done"]) {
    const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.focusKey === `${action}:1`);
    const anchor = button.parentNode;
    const tooltip = anchor.children.find(node => node.attributes.role === "tooltip");
    const svg = button.querySelectorAll("svg")[0];
    paths.push(svg.querySelectorAll("path")[0].attributes.d);
    assert.equal(button.textContent, "");
    assert.ok(button.className.split(" ").includes("icon-button"));
    assert.equal(button.attributes["aria-label"], `Mark as ${action}: <img src=x onerror=alert(1)>`);
    assert.equal(button.attributes["aria-describedby"], tooltip.id);
    assert.equal(button.attributes["aria-busy"], "false");
    assert.equal(tooltip.children[0].textContent, `Mark as ${action}`);
    assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(svg.attributes["aria-hidden"], "true");
    assert.equal(svg.attributes.focusable, "false");
    assert.equal(button.title, undefined);
    for (const event of ["pointerenter", "focus"]) {
      button.events[event]();
      assert.equal(anchor.dataset.tooltipDismissed, undefined);
      ui.document.events.keydown({ key: "Escape" });
      assert.equal(anchor.dataset.tooltipDismissed, "true");
      button.events[event]();
      assert.equal(anchor.dataset.tooltipDismissed, undefined);
      ui.window.events.blur();
      assert.equal(anchor.dataset.tooltipDismissed, "true");
    }
  }
  assert.notEqual(paths[0], paths[1]);
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("timestamps remain inside row metadata in every grouping", async t => {
  for (const groupBy of ["repo", "date", "none"]) {
    const row = thread();
    const ui = await renderer({ storedSettings: { groupBy }, initialRows: [row] });
    t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
    const article = ui.ids.get("groups").querySelectorAll("article")[0];
    const times = article.querySelectorAll("time");
    assert.equal(times.length, 1);
    assert.equal(times[0].parentNode.className, "metadata-item");
    assert.equal(times[0].parentNode.parentNode.className, "metadata");
    assert.equal(times[0].dateTime, new Date(row.updated_at).toISOString());
    assert.equal(times[0].attributes["aria-label"], new Date(row.updated_at).toLocaleString());
    assert.deepEqual(article.children.map(node => node.tag), ["a", "div"]);
    assert.equal(article.children[0].className, "row-link");
    assert.equal(article.children[1].className, "row-actions");
    assert.equal(article.children[0].contains(times[0]), true);
  }
});

test("Enter auto-repeat cannot retrigger notification actions after focus moves, but fresh presses and navigation remain native", async t => {
  const ui = await renderer();
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const actions = ui.ids.get("groups").querySelectorAll("button")
    .filter(button => button.dataset.action || button.dataset.batchAction);
  for (const id of ["batch-retry", "batch-dismiss"]) actions.push(ui.ids.get(id));
  for (const target of actions) {
    let prevented = false;
    ui.document.events.keydown({ key: "Enter", repeat: true, target, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    for (const [key, repeat] of [["Enter", false], [" ", true], ["ArrowRight", true]]) {
      ui.document.events.keydown({ key, repeat, target, preventDefault: () => assert.fail("Unrelated native keyboard behavior changed") });
    }
  }
  for (const target of [ui.ids.get("force-refresh"), ui.ids.get("groups").querySelectorAll(".row-link")[0]]) {
    ui.document.events.keydown({ key: "Enter", repeat: true, target, preventDefault: () => assert.fail("Non-action Enter must remain native") });
  }
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("Done is a distinct explicit row action in every grouping and focuses the next Done button", async t => {
  for (const groupBy of ["repo", "date", "none"]) {
    const ui = await renderer({ storedSettings: { groupBy }, initialRows: [thread("1"), thread("2")] });
    t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
    const buttons = () => ui.ids.get("groups").querySelectorAll("button");
    const done = buttons().find(button => button.dataset.focusKey === "done:1");
    assert.equal(done.textContent, "");
    assert.equal(done.querySelectorAll("svg").length, 1);
    assert.equal(done.attributes["aria-label"], "Mark as done: #42 Synthetic notification 1");
    assert.ok(buttons().some(button => button.dataset.focusKey === "read:1"));
    assert.equal(ui.calls.some(call => ["/api/read", "/api/done"].includes(call.path)), false);
    done.focus();
    await done.events.click();
    await finishRows(ui);
    assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
    assert.deepEqual(ui.patches, []);
    assert.equal(ui.document.querySelectorAll("article").length, 1);
    const next = buttons().find(button => button.dataset.focusKey === "done:2");
    assert.equal(ui.document.activeElement, next);
    await next.events.click();
    await finishRows(ui);
    assert.equal(ui.document.activeElement, ui.ids.get("search"));
    assert.equal(ui.document.querySelectorAll("article").length, 0);
  }
});

test("a pending Done action keeps rows until confirmation and blocks read, Done and repository clicks", async t => {
  let finish;
  const ui = await renderer({
    onWrite: () => new Promise(resolve => { finish = () => resolve("HTTP/2 204 No Content\r\n\r\n"); }),
  });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const buttons = ui.ids.get("groups").querySelectorAll("button");
  const done = buttons.find(button => button.dataset.focusKey === "done:1");
  const pending = done.events.click();
  await settle();
  assert.equal(done.textContent, "");
  assert.equal(done.attributes["aria-busy"], "true");
  assert.equal(done.querySelectorAll("svg").length, 1);
  assert.equal(done.parentNode.dataset.tooltipDismissed, "true");
  const read = buttons.find(button => button.dataset.focusKey === "read:1");
  assert.equal(read.attributes["aria-busy"], "false");
  assert.equal(read.querySelectorAll("svg").length, 1);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  for (const button of buttons.filter(button => !button.dataset.disclosure)) {
    assert.equal(disabled(button), true);
    await button.events.click();
  }
  assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
  assert.deepEqual(ui.patches, []);
  finish();
  await pending;
  await finishRows(ui);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
});

test("failed Done actions remain visible, restore focus and only retry on another explicit click", async t => {
  const ui = await renderer({
    onWrite: (_path, count) => count === 1 ? http({}, {}, 500) : "HTTP/2 204 No Content\r\n\r\n",
  });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const done = ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === "done:1");
  done.focus();
  await done.events.click();
  await finishRows(ui);
  assert.equal(done.disabled, false);
  assert.equal(done.textContent, "");
  assert.equal(done.attributes["aria-busy"], "false");
  assert.equal(done.querySelectorAll("svg").length, 1);
  assert.equal(ui.document.activeElement, done);
  assert.match(ui.ids.get("notice").textContent, /Could not mark the notification as done.*HTTP 500/);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  await ui.fireTimer();
  assert.equal(ui.deletions.length, 1);
  ui.advance();
  await done.events.click();
  await finishRows(ui);
  assert.equal(ui.deletions.length, 2);
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.ids.get("notice").hidden, true);
});

test("Done preserves focus across changed polls and never overrides a newer search edit", async t => {
  for (const retainDisabledFocus of [false, true]) {
    for (const editSearch of [false, true]) {
      let finish;
      let held = false;
      const ui = await renderer({
        retainDisabledFocus,
        initialRows: [thread("1"), thread("2")],
        onState: () => {
          if (held) return;
          held = true;
          return new Promise(resolve => { finish = resolve; });
        },
      });
      t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
      const buttons = () => ui.ids.get("groups").querySelectorAll("button");
      const done = buttons().find(button => button.dataset.focusKey === "done:1");
      done.focus();
      ui.inbox.pages[0].items[0].title = "Changed during polling";
      const poll = ui.fireTimer();
      await settle();
      const pending = done.events.click();
      if (editSearch) {
        const search = ui.ids.get("search");
        search.focus();
        search.value = "notification 2";
        search.events.input();
      }
      assert.deepEqual(ui.deletions, []);
      finish();
      await poll;
      await pending;
      await finishRows(ui);
      await settle();
      assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
      assert.equal(ui.document.activeElement, editSearch ? ui.ids.get("search")
        : buttons().find(button => button.dataset.focusKey === "done:2"));
      assert.equal(ui.inbox.filters.query, editSearch ? "notification 2" : "");
    }
  }
});

test("mark-read requires a click and retains the row after confirmation", async () => {
  const ui = await renderer();
  assert.equal(ui.calls.some(call => call.path === "/api/read"), false);
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  assert.match(button.attributes["aria-label"], /Mark as read/);
  button.focus();
  const marking = button.events.click();
  assert.equal(button.disabled, true);
  await button.events.click();
  await marking;
  await finishRows(ui);
  assert.equal(ui.calls.filter(call => call.path === "/api/read").length, 1);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal(ui.inbox.summary().unread, 0);
  assert.equal(ui.document.activeElement.dataset.focusKey, "done:1");
  ui.window.events.pagehide();
});

test("read rows retain disabled Read controls and Already read tooltips across external updates in every grouping", async t => {
  for (const groupBy of ["repo", "none", "date"]) {
    for (const update of ["state", "refresh"]) {
      const ui = await renderer({ storedSettings: { groupBy }, initialRows: [thread("1"), thread("2", { unread: false })] });
      t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
      const buttons = () => ui.ids.get("groups").querySelectorAll("button");
      const readButtons = () => buttons().filter(button => button.dataset.action === "read");
      const enabledReads = () => readButtons().filter(button => !button.disabled);
      assert.deepEqual(readButtons().map(button => button.dataset.threadId), ["1", "2"]);
      assert.deepEqual(enabledReads().map(button => button.dataset.threadId), ["1"]);
      assert.ok(buttons().some(button => button.dataset.focusKey === "done:2"));
      const read = readButtons()[1];
      assert.match(read.getAttribute("aria-label"), /^Already read:/);
      assert.equal(read.getAttribute("aria-keyshortcuts"), null);
      assert.equal(read.parentNode.querySelectorAll(".tooltip-content")[0].textContent, "Already read");
      read.parentNode.events.pointerenter();
      assert.equal(read.parentNode.dataset.tooltipDismissed, undefined);
      ui.document.events.keydown({ key: "Escape" });
      assert.equal(read.parentNode.dataset.tooltipDismissed, "true");
      read.parentNode.events.pointerenter();
      assert.equal(read.parentNode.dataset.tooltipDismissed, undefined);
      await read.events.click();
      assert.equal(ui.calls.some(call => call.path === "/api/read"), false);
      readButtons()[0].focus();
      if (update === "state") {
        ui.inbox.onThreadUpdated("1", "read");
        await runInContext("update()", ui.context);
      } else {
        ui.setRows([thread("1", { unread: false }), thread("2", { unread: false })]);
        await runInContext('update("refresh", { force: true })', ui.context);
      }
      assert.equal(readButtons().length, 2);
      assert.equal(enabledReads().length, 0);
      assert.ok(readButtons().every(button => button.getAttribute("aria-busy") === "false"));
      assert.equal(ui.document.querySelectorAll("article").length, 2);
      assert.equal(ui.document.activeElement.dataset.focusKey, "done:1");
      assert.deepEqual(ui.patches, []);
      assert.deepEqual(ui.deletions, []);
      ui.setRows([thread("1"), thread("2", { unread: false })]);
      await runInContext('update("refresh", { force: true })', ui.context);
      assert.deepEqual(enabledReads().map(button => button.dataset.threadId), ["1"]);
    }
  }
});

test("row reads focus the retained row's Done action across browser focus behaviors", async () => {
  for (const retainDisabledFocus of [false, true]) {
    const ui = await renderer({ retainDisabledFocus, initialRows: [
      thread("1", { updated_at: "2026-01-11T12:00:00Z" }),
      thread("2"),
    ] });
    const readButton = id => ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === id);
    const first = readButton("1");
    first.focus();
    await first.events.click();
    await finishRows(ui);
    assert.equal(ui.document.activeElement.dataset.focusKey, "done:1");
    assert.equal(ui.ids.get("search").value, "");
    ui.window.events.pagehide();
  }
});

test("row reads retain focus in their group without expanding another collapsed group", async t => {
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
      await finishRows(ui);
      assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
      assert.equal(ui.document.activeElement.dataset.focusKey, "done:1");
      assert.equal(buttons().filter(node => node.dataset.disclosure)[1].attributes["aria-expanded"], "false");
      assert.equal(ui.ids.get("groups").children[1].children[1].hidden, true);
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
  await finishRows(ui);
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
  ui.window.events.pagehide();
});

test("mark-read keeps repository activity order and retains read notifications in inbox mode", async () => {
  const ui = await renderer({ initialRows: [
    thread("1", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-30T00:00:00Z" }),
    thread("2", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-01T00:00:00Z" }),
    thread("3", { repository: { full_name: "example/middle" }, updated_at: "2026-01-20T00:00:00Z" }),
    thread("4", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-10T00:00:00Z" }),
  ] });
  const repositories = () => ui.ids.get("groups").querySelectorAll("button")
    .filter(node => node.dataset.disclosure).map(node => node.dataset.focusKey.slice("repo:".length));
  assert.deepEqual(repositories(), ["example/alpha", "example/middle", "example/zulu"]);

  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1").events.click();
  await finishRows(ui);
  assert.deepEqual(repositories(), ["example/alpha", "example/middle", "example/zulu"]);
  assert.equal(ui.document.querySelectorAll("article").length, 4);

  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "2").events.click();
  await finishRows(ui);
  assert.deepEqual(repositories(), ["example/alpha", "example/middle", "example/zulu"]);
  assert.equal(ui.document.querySelectorAll("article").length, 4);
  ui.window.events.pagehide();
});

test("Done reorders repository groups by remaining activity without losing collapsed state", async () => {
  for (const matchGitHubInbox of [true, false]) {
    const ui = await renderer({ storedSettings: { matchGitHubInbox }, initialRows: [
      thread("1", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-30T00:00:00Z" }),
      thread("2", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-20T00:00:00Z" }),
      thread("3", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-10T00:00:00Z" }),
    ] });
    const disclosures = () => ui.ids.get("groups").querySelectorAll("button").filter(button => button.dataset.disclosure);
    assert.deepEqual(disclosures().map(button => button.dataset.focusKey), ["repo:example/zulu", "repo:example/alpha"]);
    disclosures()[1].events.click();
    const done = ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === "done:1");
    done.focus();
    await done.events.click();
    await finishRows(ui);
    assert.deepEqual(disclosures().map(button => button.dataset.focusKey), ["repo:example/alpha", "repo:example/zulu"]);
    assert.equal(disclosures()[0].getAttribute("aria-expanded"), "false");
    assert.equal(ui.ids.get("groups").children[0].children[1].hidden, true);
    assert.equal(ui.document.activeElement.dataset.focusKey, "done:3");
    assert.deepEqual(ui.deletions, ["/notifications/threads/1"]);
    ui.window.events.pagehide();
    ui.inbox.close();
  }
});

test("mark-read failure retains the row with a usable retry control", async () => {
  const ui = await renderer({ readFailure: true });
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  await button.events.click();
  await finishRows(ui);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal(button.disabled, false);
  assert.match(ui.ids.get("notice").textContent, /Could not mark/);
});

test("single-item repository groups retain direct group actions alongside row actions", async () => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  const buttons = () => ui.ids.get("groups").querySelectorAll("button");
  const bulk = () => buttons().filter(button => button.dataset.batchAction === "read");
  const count = () => buttons().find(button => button.dataset.disclosure).children[1].textContent;
  assert.equal(bulk().length, 1);
  assert.equal(count(), "2 total \u00b7 2 unread");
  await runInContext('update("filters", { query: "notification 1" })', ui.context);
  assert.equal(bulk().length, 1);
  assert.equal(groupActionText(bulk()[0]), "Mark 1 as read");
  assert.equal(groupActionText(buttons().find(button => button.dataset.batchAction === "done")), "Mark 1 as done");
  assert.equal(count(), "1 total \u00b7 1 unread");
  assert.equal(buttons().find(button => button.dataset.threadId === "1").disabled, false);
  await runInContext('update("filters", { query: "no match" })', ui.context);
  assert.equal(bulk().length, 0);
  await runInContext('update("filters", { query: "" })', ui.context);
  assert.equal(bulk().length, 1);
  const row = buttons().find(button => button.dataset.threadId === "1");
  row.focus();
  await row.events.click();
  await finishRows(ui);
  assert.equal(bulk().length, 1);
  assert.equal(groupActionText(bulk()[0]), "Mark 1 as read");
  assert.equal(count(), "2 total \u00b7 1 unread");
  assert.equal(ui.document.activeElement.dataset.focusKey, "done:1");
  await buttons().find(button => button.dataset.focusKey === "read:2").events.click();
  await finishRows(ui);
  assert.equal(ui.document.querySelectorAll("article").length, 2);
  assert.equal(bulk().length, 1);
  assert.equal(disabled(bulk()[0]), true);
  assert.deepEqual(ui.patches, ["/notifications/threads/1", "/notifications/threads/2"]);
  assert.equal(ui.calls.some(call => call.path.startsWith("/api/batch/")), false);
  ui.window.events.pagehide();
});

test("repository headers stay highlighted while only their action buttons change on hover", async () => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  const buttons = ui.ids.get("groups").querySelectorAll("button");
  const disclosure = buttons.find(node => node.dataset.disclosure);
  const groupRead = buttons.find(node => node.dataset.focusKey === "bulk:example/widgets");
  assert.equal(disclosure.className, "repo-toggle");
  assert.equal(disclosure.parentNode.className, "repo-header");
  assert.equal(groupRead.parentNode.className, "tooltip-anchor");
  assert.equal(groupRead.parentNode.parentNode.className, "repo-actions");
  assert.equal(groupRead.parentNode.parentNode.parentNode, disclosure.parentNode);
  assert.match(styles, /button:hover:not\(:disabled, \[aria-disabled="true"\], \.repo-toggle\),\s+summary:hover,\s+\.icon-button:hover:not\(:disabled, \[aria-disabled="true"\]\),\s+\.row:hover \{\s*background: color-mix\(in srgb, var\(--canvas-text\) 4%, transparent\);/);
  assert.match(styles, /\.repo-header \{[^}]*background: color-mix\(in srgb, var\(--canvas-text\) 4%, transparent\);/);
  assert.doesNotMatch(styles, /\.repo-header:hover/);
  assert.match(styles, /@media \(prefers-reduced-motion: no-preference\) \{\s*button,\s+a,\s+\.repo-header \{\s+transition: background-color 0?\.12s ease;\s+\}/);
  ui.window.events.pagehide();
});

test("repository toggle focus is inset inside the clipped card", () => {
  assert.match(styles, /:focus-visible \{\s+outline: 2px solid var\(--focus\);\s+outline-offset: 3px;\s+\}/);
  assert.match(styles, /\.repo-group \{[^}]*overflow: clip;/);
  assert.match(styles, /\.repo-toggle:focus-visible \{\s+outline-offset: -3px;\s+\}/);
});

test("compact toolbar aligns the title and utility icons above full-width search", () => {
  assert.match(styles, /\.toolbar \{\s+display: flex;\s+align-items: center;[^}]*\}/);
  assert.match(styles, /\.search \{\s+display: block;\s+min-width: 0;[^}]*\}/);
  assert.match(styles, /\.search input \{\s+height: 38px;\s+\}/);
  assert.match(styles, /\.icon-button \{[^}]*flex-shrink: 0;[^}]*width: 38px;\s+height: 38px;[^}]*color: var\(--canvas-text\);/);
  assert.match(styles, /\.settings \{[^}]*flex-shrink: 0;/);
  assert.doesNotMatch(styles.match(/(?:^|\n)\.toolbar \{[^}]*\}/)[0], /flex-wrap: wrap/);
  assert.match(styles, /@media \(max-width: 360px\) \{\s+\.toolbar \{\s+flex-wrap: wrap;\s+justify-content: flex-end;\s+\}\s+\.toolbar h1 \{\s+flex-basis: 100%;/);
});

test("notification metadata, counts and action tooltips use 12px text", () => {
  for (const selector of ["\\.metadata", "time", "\\.repo-count", "\\.tooltip-content"]) {
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
    initialRows: [thread("1"), thread("2")],
    onWrite: (_path, count) => count === 1
      ? new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); })
      : "HTTP/2 205 Reset Content\r\n\r\n",
  });
  const buttons = ui.ids.get("groups").querySelectorAll("button");
  const disclosure = buttons.find(node => node.dataset.disclosure);
  const groupRead = buttons.find(node => node.dataset.focusKey === "bulk:example/widgets");
  assert.match(groupActionText(groupRead), /Mark 2 as read/);
  assert.equal(disclosure.contains(groupRead), false);
  assert.equal(groupRead.contains(disclosure), false);
  disclosure.events.click();
  groupRead.focus();
  await groupRead.events.click();
  await settle();
  assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
  assert.deepEqual(ui.calls.filter(call => call.path.startsWith("/api/batch/")).map(call => call.path), ["/api/batch/start"]);
  assert.equal(ui.document.activeElement, groupRead);
  assert.equal(disclosure.attributes["aria-expanded"], "false");
  await runInContext("update()", ui.context);
  assert.match(groupActionText(groupRead), /Marking 0\/2 as read/);
  assert.equal(groupProgress(ui, "repo:example/widgets"), "Marking 0/2 as read...");
  assert.equal(groupRead.attributes["aria-busy"], "true");
  assert.doesNotMatch(html, /batch-confirm|batch-start|batch-cancel|batch-stop/);
  assert.doesNotMatch(script, /batch\/prepare|Repository action finished/);
  assert.ok(!ui.ids.get("shortcuts-dialog").open);
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.ids.get("batch-title").textContent, "");
  assert.equal(ui.ids.get("batch-counts").textContent, "");
  assert.equal(ui.document.activeElement.dataset.focusKey, "repo:example/widgets");
});

test("one-click repository read honors search, blocks duplicate clicks and retains successful rows", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2"), thread("10")],
    onWrite: (_path, count) => count === 1
      ? new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); })
      : "HTTP/2 205 Reset Content\r\n\r\n",
  });
  await runInContext('update("filters", { query: "notification 1" })', ui.context);
  const groupRead = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.focusKey.startsWith("bulk:"));
  assert.equal(groupActionText(groupRead), "Mark 2 as read");
  groupRead.focus();
  const first = groupRead.events.click();
  await groupRead.events.click();
  await first;
  assert.equal(ui.ids.get("search").disabled, false);
  assert.equal(ui.inbox.batch.snapshot().total, 2);
  assert.equal(ui.inbox.batch.snapshot().searchActive, true);
  assert.equal(ui.document.activeElement, groupRead);
  await settle();
  await runInContext("update()", ui.context);
  assert.match(groupActionText(groupRead), /Marking 0\/2/);
  assert.equal(ui.ids.has("refresh"), false);
  assert.equal(ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1").disabled, true);
  release();
  await ui.inbox.batch.done;
  await runInContext("tick()", ui.context);
  assert.equal(ui.inbox.batch.snapshot(), null);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("batch-counts").textContent, "");
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.deepEqual(ui.patches, ["/notifications/threads/1", "/notifications/threads/10"]);
  assert.equal(ui.inbox.summary().loaded, 3);
  assert.equal(ui.inbox.summary().unread, 1);
  assert.equal(ui.document.querySelectorAll("article").length, 2);
  assert.equal(ui.document.activeElement.dataset.focusKey, "repo:example/widgets");
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
  assert.equal(ui.document.querySelectorAll("article").length, 3);
  assert.equal(ui.inbox.summary().unread, 0);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("batch-counts").textContent, "");
  assert.equal(ui.ids.get("batch-error").textContent, "");
  assert.equal(ui.document.activeElement.dataset.focusKey, "repo:example/widgets");
});

test("batch failure to reconnect is visible and never silently retries a mutation", async () => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  ui.setOffline(true);
  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.focusKey.startsWith("bulk:")).events.click();
  assert.equal(ui.ids.has("batch-confirm"), false);
  assert.match(ui.ids.get("notice").textContent, /Synthetic connection failure/);
  assert.equal(ui.patches.length, 0);
});

test("a group changed before the click is accepted reloads its count instead of marking a wider selection", async () => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  const oldButton = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository);
  assert.equal(groupActionText(oldButton), "Mark 2 as read");
  ui.inbox.pages[0].items.push({ ...ui.inbox.pages[0].items[0], id: "3", title: "Synthetic newcomer" });
  await oldButton.events.click();
  assert.deepEqual(ui.patches, []);
  assert.match(ui.ids.get("notice").textContent, /shown selection changed/);
  const currentButton = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository);
  assert.equal(groupActionText(currentButton), "Mark 3 as read");
  assert.equal(currentButton.disabled, false);
});

test("a long batch keeps focus in its group and clears inline progress after completion", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2")],
    onWrite: (_path, count) => count === 2
      ? new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); })
      : "HTTP/2 205 Reset Content\r\n\r\n",
  });
  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository).events.click();
  await settle();
  assert.equal(ui.ids.has("batch-stop"), false);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.document.activeElement.dataset.focusKey, "bulk:example/widgets");
  assert.equal(ui.inbox.batch.snapshot().status, "running");
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("batch-progress").hidden, true);
  assert.equal(ui.ids.get("batch-title").textContent, "");
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.document.activeElement.dataset.focusKey, "repo:example/widgets");
});

test("local status polling preserves keyboard focus on row and repository read controls", async () => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
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
  let held = false;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2")],
    onState: () => {
      if (held) return;
      held = true;
      return new Promise(resolve => { release = resolve; });
    },
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
  await finishRows(ui);
  assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
  assert.equal(ui.document.querySelectorAll("article").length, 2);
  assert.equal(ui.document.activeElement.dataset.focusKey, "done:1");
  assert.equal(ui.document.activeElement.disabled, false);
});

test("changed local polls do not steal focus from pending row reads", async t => {
  for (const retainDisabledFocus of [false, true]) {
    for (const moveFocus of [false, true]) {
      let release;
      let held = false;
      const ui = await renderer({
        retainDisabledFocus,
        initialRows: [thread("1"), thread("2")],
        onState: () => {
          if (held) return;
          held = true;
          return new Promise(resolve => { release = resolve; });
        },
      });
      t.after(() => { release?.(); ui.window.events.pagehide(); ui.inbox.close(); });
      const buttons = () => ui.ids.get("groups").querySelectorAll("button");
      const button = buttons().find(node => node.dataset.threadId === "1");
      button.focus();
      ui.inbox.pages[0].items[0].title = "Changed during status polling";
      const polling = ui.fireTimer();
      await settle();
      const reading = button.events.click();
      assert.equal(button.disabled, true);
      assert.deepEqual(ui.patches, []);
      if (moveFocus) ui.ids.get("search").focus();
      release();
      await polling;
      await reading;
      await finishRows(ui);
      assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
      assert.equal(ui.document.querySelectorAll("article").length, 2);
      assert.equal(ui.document.activeElement, moveFocus ? ui.ids.get("search")
        : buttons().find(node => node.dataset.focusKey === "done:1"));
    }
  }
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
  assert.equal(ui.document.querySelectorAll("article").length, 2);
  assert.equal(ui.inbox.summary().unread, 0);
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
    await finishRows(ui);
    await settle();
    assert.equal(search.value, "notification 3");
    assert.equal(ui.inbox.filters.query, "notification 3");
    assert.equal(ui.document.querySelectorAll("article").length, 1);
    assert.equal(ui.document.querySelectorAll(".title")[0].textContent, "Synthetic notification 3");
    assert.deepEqual(ui.calls.filter(call => call.path === "/api/filters").map(call => JSON.parse(call.options.body).query), ["notification 2", "notification 3"]);
    assert.equal(ui.document.activeElement, search);
    assert.equal(ui.ids.get("notice").hidden, success);
  }
});

test("a read cannot overtake an already pending search debounce", async () => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  const search = ui.ids.get("search");
  search.value = "notification 2";
  search.events.input();
  const button = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1");
  await button.events.click();
  assert.equal(button.disabled, true);
  assert.deepEqual(ui.patches, []);
  await ui.fireTimer(250);
  assert.equal(ui.inbox.filters.query, "notification 2");
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal([...ui.timers.values()].some(timer => timer.delay === 250), false);
});

test("a repository batch waits for pending search and uses the resulting selection", async () => {
  let release;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2", { repository: { full_name: "example/other" } }), thread("3")],
    onWrite: (_path, count) => count === 1
      ? new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); })
      : "HTTP/2 205 Reset Content\r\n\r\n",
  });
  const search = ui.ids.get("search");
  search.value = "other";
  search.events.input();
  const group = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository === "example/widgets");
  await group.events.click();
  await settle();
  assert.equal(search.disabled, false);
  assert.deepEqual(ui.patches, []);
  await ui.fireTimer(250);
  const matching = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.repository === "example/other");
  await matching.events.click();
  await settle();
  assert.equal(search.disabled, false);
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  await settle();
  assert.equal(search.disabled, false);
  assert.equal(search.value, "other");
  assert.equal(ui.inbox.filters.query, "other");
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.deepEqual(ui.patches, ["/notifications/threads/2"]);
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
  await finishRows(failed);
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
