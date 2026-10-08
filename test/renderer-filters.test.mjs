import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { renderer, settle } from "./renderer-fixtures.mjs";
import { thread } from "./fixtures.mjs";

const rows = ["review_requested", "mention", "team_mention", "assign", "author", "comment", "subscribed"]
  .map((reason, index) => thread(String(index + 1), { reason }));
const tab = (ui, value) => ui.document.getElementById(`attention-${value}`);
const shown = ui => ui.ids.get("groups").querySelectorAll("button")
  .filter(button => button.dataset.action === "read").map(button => button.dataset.threadId);

test("attention tabs default to All, combine with search in every grouping, and distinguish no matches from caught up", async () => {
  for (const groupBy of ["repo", "date", "none"]) {
    const ui = await renderer({ initialRows: rows, storedSettings: { groupBy } });
    assert.equal(tab(ui, "all").attributes["aria-selected"], "true");
    assert.equal(tab(ui, "all").tabIndex, 0);
    assert.deepEqual(ui.ids.get("attention-tabs").children.map(button => button.textContent),
      ["All (7)", "Review requested (1)", "Mentioned (2)", "Assigned (1)", "Participating (2)"]);
    const metadata = ui.ids.get("groups").querySelectorAll("div").filter(node => node.className === "metadata");
    assert.deepEqual(metadata[0].children.map(node => node.children[0]).filter(node => node.tag !== "time").map(node => node.textContent),
      [...(groupBy === "repo" ? [] : ["example/widgets"]), "Pull Request #42", "review requested"]);
    assert.equal(metadata.some(node => node.querySelectorAll("span").some(child => child.textContent === "Unread")), false);
    for (const [value, ids] of [
      ["review_requested", ["1"]], ["mentioned", ["2", "3"]], ["assigned", ["4"]],
      ["participating", ["5", "6"]], ["all", ["1", "2", "3", "4", "5", "6", "7"]],
    ]) {
      const button = tab(ui, value);
      button.focus();
      await button.events.click();
      assert.deepEqual(shown(ui), ids);
      const bulk = ui.ids.get("groups").querySelectorAll("button").filter(button => button.dataset.batchAction === "read");
      assert.equal(bulk.length, groupBy === "repo" && ids.length > 0 ? 1 : 0);
      assert.equal(button.attributes["aria-selected"], "true");
      assert.equal(button.tabIndex, 0);
      assert.equal(ui.document.activeElement, button);
      assert.equal(ui.ids.get("attention-panel").attributes["aria-labelledby"], button.id);
    }
    await tab(ui, "mentioned").events.click();
    const search = ui.ids.get("search");
    search.value = "notification 3";
    search.events.input();
    await ui.fireTimer(250);
    assert.deepEqual(shown(ui), ["3"]);
    assert.equal(ui.ids.get("count").textContent, "7 unread \u00b7 1 matching");
    assert.equal(tab(ui, "all").textContent, "All (7)");
    assert.equal(tab(ui, "mentioned").textContent, "Mentioned (2)");
    assert.equal(tab(ui, "assigned").textContent, "Assigned (1)");
    await tab(ui, "assigned").events.click();
    assert.deepEqual(shown(ui), []);
    assert.equal(search.value, "notification 3");
    assert.equal(tab(ui, "mentioned").textContent, "Mentioned (2)");
    assert.equal(tab(ui, "all").textContent, "All (7)");
    assert.equal(ui.ids.get("empty-title").textContent, "No matches in loaded notifications");
    assert.equal(ui.ids.get("count").hidden, false);
    assert.match(ui.ids.get("empty-description").textContent, /another attention filter/);
    assert.equal(ui.githubCalls.length, 1);
  }
});

test("keyboard tabs wrap and support Home and End without changing focus on polls", async () => {
  const ui = await renderer({ initialRows: rows });
  let current = "all";
  for (const [key, expected] of [
    ["ArrowLeft", "participating"], ["ArrowRight", "all"], ["ArrowRight", "review_requested"],
    ["End", "participating"], ["Home", "all"],
  ]) {
    let prevented = false;
    await tab(ui, current).events.keydown({ key, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(ui.inbox.filters.attention, expected);
    assert.equal(ui.document.activeElement, tab(ui, expected));
    assert.equal(tab(ui, expected).lastScroll.inline, "nearest");
    assert.equal(tab(ui, expected).lastScroll.block, "nearest");
    await ui.fireTimer();
    assert.equal(ui.document.activeElement, tab(ui, expected));
    current = expected;
  }
  const calls = ui.calls.length;
  await tab(ui, "all").events.keydown({ key: "Tab", preventDefault: () => assert.fail("Tab must not be intercepted") });
  await tab(ui, "all").events.click();
  assert.equal(ui.calls.length, calls);
});

test("passive count updates reveal focused tabs horizontally without scrolling ancestors", async () => {
  for (const [bounds, expected] of [
    [{ left: 10.2, right: 110 }, 80],
    [{ left: 199, right: 299.3 }, 140],
    [{ left: 40, right: 140 }, 100],
  ]) {
    const ui = await renderer({ initialRows: rows });
    const strip = ui.ids.get("attention-tabs");
    ui.ids.get("attention-navigation").clientWidth = 300;
    Object.assign(strip, { clientWidth: 230, scrollWidth: 600, scrollLeft: 100, bounds: { left: 30, right: 260 } });
    const focused = tab(ui, "all");
    focused.bounds = bounds;
    focused.focus();
    ui.inbox.onThreadUpdated("7");
    await runInContext("update()", ui.context);
    assert.equal(focused.textContent, "All (6)");
    assert.equal(strip.scrollLeft, expected);
    assert.equal(focused.lastScroll, undefined);
    assert.equal(ui.document.activeElement, focused);
    ui.window.events.pagehide();
  }
});

test("latest tab and search edits are merged while a filter request is in flight", async () => {
  let release;
  let count = 0;
  const ui = await renderer({ initialRows: rows, onFilters: () =>
    ++count === 1 ? new Promise(resolve => { release = resolve; }) : undefined });
  const filtering = tab(ui, "review_requested").events.click();
  await settle();
  const search = ui.ids.get("search");
  search.value = "notification 3";
  search.events.input();
  await tab(ui, "assigned").events.click();
  tab(ui, "mentioned").focus();
  await tab(ui, "mentioned").events.click();
  release();
  await filtering;
  await settle();
  assert.deepEqual(ui.inbox.filters, { mode: "unread", query: "notification 3", attention: "mentioned" });
  assert.deepEqual(shown(ui), ["3"]);
  assert.equal(ui.document.activeElement, tab(ui, "mentioned"));
  assert.deepEqual(ui.calls.filter(call => call.path === "/api/filters").map(call => JSON.parse(call.options.body)), [
    { attention: "review_requested" }, { query: "notification 3", attention: "mentioned" },
  ]);
});

test("keyboard navigation moves the tab stop immediately, before filtering completes", async () => {
  let release;
  const ui = await renderer({ initialRows: rows, onFilters: () => new Promise(resolve => { release = resolve; }) });
  const filtering = tab(ui, "all").events.keydown({ key: "End", preventDefault() {} });
  await settle();
  assert.equal(tab(ui, "all").tabIndex, -1);
  assert.equal(tab(ui, "participating").tabIndex, 0);
  await runInContext("render()", ui.context);
  assert.equal(tab(ui, "all").tabIndex, -1);
  assert.equal(tab(ui, "participating").tabIndex, 0);
  ui.ids.get("search").focus();
  release();
  await filtering;
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
  assert.equal(tab(ui, "participating").tabIndex, 0);
});

test("a failed attention request retains both failed and newer fields for a later retry", async () => {
  let reject;
  let fail = true;
  const ui = await renderer({ initialRows: rows, onFilters: () =>
    fail ? new Promise((_, rejectRequest) => { reject = rejectRequest; }) : undefined });
  const filtering = tab(ui, "mentioned").events.click();
  await settle();
  const search = ui.ids.get("search");
  search.value = "notification 3";
  search.events.input();
  reject(new Error("Synthetic filter failure"));
  await filtering;
  assert.equal(ui.ids.get("notice").hidden, false);
  assert.equal(tab(ui, "all").attributes["aria-selected"], "true");
  assert.equal(search.value, "notification 3");
  assert.equal(tab(ui, "mentioned").textContent, "Mentioned (2)");
  fail = false;
  await ui.fireTimer();
  assert.deepEqual(shown(ui), ["3"]);
  assert.equal(tab(ui, "mentioned").attributes["aria-selected"], "true");
  assert.equal(tab(ui, "mentioned").textContent, "Mentioned (2)");
});

test("queued tab changes survive row read/done actions, a local poll, and hiding the panel", async () => {
  for (const operation of ["read", "done", "poll"]) {
    let release;
    const ui = await renderer({ initialRows: rows,
      onWrite: operation !== "poll" ? () => new Promise(resolve => {
        release = () => resolve(`HTTP/2 ${operation === "done" ? 204 : 205} Synthetic\r\n\r\n`);
      }) : undefined,
      onState: operation === "poll" ? () => new Promise(resolve => { release = resolve; }) : undefined,
    });
    const pending = operation !== "poll" ?
      ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === `${operation}:1`).events.click() :
      ui.fireTimer();
    await settle();
    const filtering = tab(ui, "mentioned").events.click();
    await tab(ui, "assigned").events.click();
    ui.intersect(false);
    release();
    await pending;
    await filtering;
    ui.intersect(true);
    await settle();
    assert.equal(ui.inbox.filters.attention, "assigned");
    assert.deepEqual(shown(ui), ["4"]);
  }
});

test("tabs cannot change the selection during a repository batch or without a capability", async () => {
  let release;
  const ui = await renderer({ initialRows: [...rows, thread("8")],
    onWrite: (_path, count) => count === 1
      ? new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); })
      : "HTTP/2 205 Reset Content\r\n\r\n",
  });
  await tab(ui, "review_requested").events.click();
  await ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.repository).events.click();
  await settle();
  assert.equal(tab(ui, "mentioned").disabled, true);
  await tab(ui, "mentioned").events.click();
  await tab(ui, "review_requested").events.keydown({ key: "ArrowRight", preventDefault: () => assert.fail("Disabled tab") });
  assert.equal(ui.inbox.filters.attention, "review_requested");
  release();
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
  assert.equal(tab(ui, "mentioned").disabled, false);
  assert.equal(ui.ids.get("empty-title").textContent, "No matches in loaded notifications");
  assert.equal(ui.ids.get("count").textContent, "6 unread \u00b7 0 matching");
  assert.equal(tab(ui, "review_requested").textContent, "Review requested (0)");
  assert.equal(tab(ui, "mentioned").textContent, "Mentioned (2)");
  assert.equal(tab(ui, "all").textContent, "All (6)");
  assert.deepEqual(ui.patches, ["/notifications/threads/1", "/notifications/threads/8"]);

  const missing = await renderer({ token: "" });
  assert.equal(tab(missing, "all").disabled, true);
  assert.equal(tab(missing, "all").textContent, "All");
  await tab(missing, "mentioned").events.click();
  assert.deepEqual(missing.calls, []);
});

test("clearing search preserves the selected attention tab and focus without fetching or writing", async () => {
  for (const [attention, ids] of [
    ["review_requested", ["1"]], ["mentioned", ["2", "3"]], ["assigned", ["4"]], ["participating", ["5", "6"]],
  ]) {
    const ui = await renderer({ initialRows: rows });
    assert.equal(ui.ids.has("clear-filters"), false);
    await runInContext(`update("filters", ${JSON.stringify({ query: "no matching title", attention })})`, ui.context);
    assert.deepEqual(shown(ui), []);
    const search = ui.ids.get("search");
    search.focus();
    const requests = ui.githubCalls.length;
    search.value = "pending search";
    search.events.input();
    search.value = "";
    search.events.input();
    await ui.fireTimer(250);
    assert.deepEqual(ui.inbox.filters, { mode: "unread", query: "", attention });
    assert.equal(search.value, "");
    assert.equal(tab(ui, attention).attributes["aria-selected"], "true");
    assert.equal(ui.document.activeElement, search);
    assert.deepEqual(shown(ui), ids);
    assert.equal(ui.githubCalls.length, requests);
    assert.equal([...ui.timers.values()].some(timer => timer.delay === 250), false);
    assert.deepEqual(ui.patches, []);
  }
});

test("a failed search clear retries without changing the attention tab", async () => {
  let fail = false;
  const ui = await renderer({ initialRows: rows, onFilters: () => {
    if (fail) throw new Error("Synthetic filter failure");
  } });
  await runInContext('update("filters", { query: "no match", attention: "mentioned" })', ui.context);
  fail = true;
  const search = ui.ids.get("search");
  search.focus();
  search.value = "";
  search.events.input();
  await ui.fireTimer(250);
  assert.equal(ui.ids.get("notice").hidden, false);
  assert.equal(ui.inbox.filters.query, "no match");
  assert.equal(ui.inbox.filters.attention, "mentioned");
  assert.equal(search.value, "");
  fail = false;
  await ui.fireTimer();
  assert.deepEqual(ui.inbox.filters, { mode: "unread", query: "", attention: "mentioned" });
  assert.deepEqual(shown(ui), ["2", "3"]);
  assert.equal(ui.document.activeElement, search);
  assert.deepEqual(ui.patches, []);
});

test("overflow arrows reveal tabs without requests, retain focus at the ends, and follow manual scrolling", async () => {
  const ui = await renderer({ initialRows: rows });
  const strip = ui.ids.get("attention-tabs");
  const navigation = ui.ids.get("attention-navigation");
  const previous = ui.ids.get("attention-previous");
  const next = ui.ids.get("attention-next");
  assert.equal(previous.hidden, true);
  assert.equal(next.hidden, true);
  await next.events.click();
  assert.equal(strip.scrollLeft, 0);
  navigation.clientWidth = 300;
  Object.assign(strip, { clientWidth: 236, scrollWidth: 600 });
  ui.resizeAttention();
  assert.equal(previous.hidden, false);
  assert.equal(next.hidden, false);
  assert.equal(previous.attributes["aria-disabled"], "true");
  assert.equal(next.attributes["aria-disabled"], "false");
  await previous.events.click();
  assert.equal(strip.scrollLeft, 0);
  const calls = ui.calls.length;
  next.focus();
  for (let index = 0; index < 4; index++) await next.events.click();
  assert.equal(strip.scrollLeft, 364);
  assert.equal(next.attributes["aria-disabled"], "true");
  assert.equal(previous.attributes["aria-disabled"], "false");
  assert.equal(ui.document.activeElement, next);
  previous.focus();
  for (let index = 0; index < 4; index++) await previous.events.click();
  assert.equal(strip.scrollLeft, 0);
  assert.equal(ui.document.activeElement, previous);
  assert.equal(previous.attributes["aria-disabled"], "true");
  strip.scrollLeft = 100;
  strip.events.scroll();
  assert.equal(previous.attributes["aria-disabled"], "false");
  assert.equal(next.attributes["aria-disabled"], "false");
  strip.scrollLeft = 363.5;
  strip.events.scroll();
  assert.equal(next.attributes["aria-disabled"], "true");
  assert.equal(ui.inbox.filters.attention, "all");
  assert.equal(ui.calls.length, calls);
});

test("arrows disappear when tabs fit the full strip, respond to count widths, and disconnect on close", async () => {
  const ui = await renderer({ initialRows: rows });
  const strip = ui.ids.get("attention-tabs");
  const navigation = ui.ids.get("attention-navigation");
  const next = ui.ids.get("attention-next");
  navigation.clientWidth = 600;
  Object.assign(strip, { clientWidth: 536, scrollWidth: 650 });
  ui.resizeAttention();
  assert.equal(next.hidden, false);
  next.focus();
  // The content still overflows the reduced viewport, but fits without arrows.
  strip.scrollWidth = 590;
  await runInContext("render()", ui.context);
  assert.equal(next.hidden, true);
  assert.equal(ui.document.activeElement, tab(ui, "all"));
  strip.scrollWidth = 650;
  ui.resizeAttention();
  assert.equal(next.hidden, false);
  navigation.clientWidth = 700;
  ui.resizeAttention();
  assert.equal(next.hidden, true);
  assert.equal(ui.attentionObserved.length, 6);
  assert.equal(ui.attentionObserved[0], navigation);
  assert.equal(ui.attentionObserved.includes(tab(ui, "participating")), true);
  ui.window.events.pagehide();
  assert.equal(ui.attentionDisconnected, true);
  assert.equal(strip.events.scroll, undefined);
});
