import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { renderer, settle } from "./renderer-fixtures.mjs";
import { http, next, thread } from "./fixtures.mjs";

test("clearing loaded rows waits for reconciliation before claiming the inbox is caught up", async t => {
  for (const hasMore of [false, true]) {
    for (const action of ["read", "done"]) {
      let fetches = 0;
      const ui = await renderer({ onFetch: () => ++fetches === 1
        ? http([thread("1"), thread("2")], hasMore ? { link: next } : {})
        : http(hasMore ? [thread("3")] : []) });
      t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
      for (const id of ["1", "2"]) {
        await ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === `${action}:${id}`).events.click();
      }
      assert.equal(fetches, 1);
      assert.equal(ui.ids.get("empty-title").textContent, "Loaded notifications cleared");
      assert.equal(ui.ids.get("empty-description").textContent, "Refresh to check for remaining unread notifications.");
      assert.equal(ui.ids.get("count").hidden, false);
      const refresh = ui.ids.get("empty-refresh");
      assert.equal(refresh.hidden, false);
      refresh.focus();
      await refresh.events.click();
      assert.equal(fetches, 2);
      assert.equal(refresh.hidden, true);
      assert.equal(ui.document.activeElement, ui.ids.get("search"));
      if (hasMore) {
        assert.equal(ui.ids.get("empty").hidden, true);
        assert.deepEqual(ui.inbox.loadedItems().map(item => item.id), ["3"]);
      } else {
        assert.equal(ui.ids.get("empty-title").textContent, "All caught up \u{1F389}");
        assert.equal(ui.ids.get("count").hidden, true);
      }
    }
  }
});

test("empty loaded pages with a next page offer loading rather than an unnecessary refresh", async t => {
  const ui = await renderer({ onFetch: () => http([], { link: next }) });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  assert.equal(ui.ids.get("empty-title").textContent, "Loaded notifications cleared");
  assert.equal(ui.ids.get("empty-description").textContent, "Load more to continue through your unread notifications.");
  assert.equal(ui.ids.get("empty-refresh").hidden, true);
  assert.equal(ui.ids.get("more").disabled, false);
});

test("no-match guidance only offers pagination when more items are available", async t => {
  for (const hasMore of [false, true]) {
    for (const filters of [{ query: "no matches" }, { attention: "mentioned" }]) {
      const ui = await renderer({ onFetch: () => http([thread()], hasMore ? { link: next } : {}) });
      t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
      await runInContext(`update("filters", ${JSON.stringify(filters)})`, ui.context);
      assert.equal(ui.ids.get("empty-description").textContent.includes("Load more"), hasMore);
      assert.equal(ui.ids.get("empty-refresh").hidden, true);
      ui.inbox.needsRefresh = true;
      await runInContext("update()", ui.context);
      assert.equal(ui.ids.get("empty-description").textContent.includes("Refresh"), hasMore);
      assert.doesNotMatch(ui.ids.get("empty-description").textContent, /Load more/);
    }
  }
});

test("Settings closes when focus leaves it without moving focus back to the toggle", async t => {
  const ui = await renderer();
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const settings = ui.ids.get("settings");
  settings.open = true;
  ui.document.events.focusin({ target: ui.ids.get("group-by") });
  assert.equal(settings.open, true);
  const search = ui.ids.get("search");
  search.focus();
  ui.document.events.focusin({ target: search });
  assert.equal(settings.open, false);
  assert.equal(ui.ids.get("settings-toggle").attributes["aria-expanded"], "false");
  assert.equal(ui.ids.get("settings-toggle").dataset.tooltipDismissed, "true");
  assert.equal(ui.document.activeElement, search);
});

test("retry deadlines distinguish backoff from polling and keep paused refresh controls focusable", async t => {
  for (const first of [http({}, {}, 500), http([thread()], { "x-ratelimit-remaining": "0" })]) {
    let fetches = 0;
    const ui = await renderer({ onFetch: () => ++fetches === 1 ? first : http([thread()]) });
    t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
    const deadline = ui.inbox.summary().retryAt;
    assert.equal(deadline, ui.advance(0) + 120_000);
    assert.equal(ui.ids.get("retry-status").hidden, false);
    assert.equal(ui.ids.get("retry-status").textContent,
      `GitHub requests paused. Retry after ${new Date(deadline).toLocaleTimeString()}.`);
    for (const id of ["force-refresh", "empty-refresh"]) {
      const button = ui.ids.get(id);
      assert.equal(button.attributes["aria-disabled"], "true");
      assert.equal(button.disabled, false);
      await button.events.click();
    }
    assert.equal(fetches, 1);
    ui.ids.get("force-refresh").focus();
    assert.equal(ui.document.activeElement, ui.ids.get("force-refresh"));
    ui.intersect(false);
    ui.intersect(true);
    await settle();
    assert.equal(fetches, 1);
    assert.equal(ui.ids.get("force-refresh").attributes["aria-busy"], "false");
    await runInContext('update("filters", { query: "notification" })', ui.context);
    assert.equal(ui.inbox.filters.query, "notification");
    ui.advance(deadline - ui.advance(0));
    await ui.fireTimer();
    assert.equal(fetches, 2);
    assert.equal(ui.ids.get("retry-status").hidden, true);
    assert.equal(ui.ids.get("force-refresh").attributes["aria-disabled"], "false");
    assert.equal(ui.inbox.summary().retryAt <= ui.advance(0), true);
    assert.equal(ui.inbox.summary().nextRefreshAt > ui.advance(0), true);
    await ui.ids.get("force-refresh").events.click();
    assert.equal(fetches, 3);
  }
});

test("row failures immediately reconcile backoff and failed reconciliation remains explicit", async t => {
  for (const disconnect of [false, true]) {
    const ui = await renderer({ onWrite: () => {
      if (disconnect) ui.setOffline(true);
      return http({}, { "retry-after": "600" }, 429);
    } });
    t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
    await ui.ids.get("groups").querySelectorAll("button").find(button => button.dataset.focusKey === "done:1").events.click();
    assert.equal(ui.document.querySelectorAll("article").length, 1);
    assert.equal(ui.deletions.length, 1);
    if (disconnect) {
      assert.match(ui.ids.get("notice").textContent, /Could not reconnect/);
    } else {
      assert.equal(ui.ids.get("retry-status").hidden, false);
      assert.equal(ui.ids.get("force-refresh").attributes["aria-disabled"], "true");
      assert.equal(ui.inbox.summary().retryAt, ui.advance(0) + 600_000);
    }
  }
});

test("stopped batches keep nonzero skipped counts and preserve failure details when present", async t => {
  const ui = await renderer();
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  await runInContext(`state.batch = {
    scope: "shown", action: "done", status: "cancelled", total: 4,
    succeeded: 1, failed: 0, skipped: 1, notAttempted: 2, retryAt: 0
  }; render()`, ui.context);
  assert.equal(ui.ids.get("batch-counts").textContent, "1 marked done, 2 remaining, 1 skipped");
  assert.equal(ui.ids.get("batch-retry").textContent, "Continue remaining (2)");
  await runInContext('state.batch.error = { message: "Outcome unknown" }; render()', ui.context);
  assert.equal(ui.ids.get("batch-retry").textContent, "Retry remaining (2)");
  assert.match(ui.ids.get("batch-counts").textContent, /1 succeeded \/ 0 failed \/ 1 skipped \/ 2 not attempted/);
  assert.equal(ui.ids.get("batch-error").textContent, "Outcome unknown");
});

test("shared action errors use scope-neutral and read-or-Done wording", async t => {
  const ui = await renderer();
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const client = ui.inbox.client;
  const owner = client.reserveThreads(["1"]);
  assert.throws(() => client.markDone("1"), { code: "busy", message: "This notification belongs to an active batch." });
  client.releaseThreads(owner);
  await assert.rejects(ui.inbox.markDone({ id: "bad" }), {
    code: "invalid_thread", message: "Choose one valid notification to mark as read or done.",
  });
  ui.inbox.needsRefresh = true;
  await assert.rejects(ui.inbox.more(), {
    code: "refresh_required", message: "Refresh notifications before loading more after marking a notification as read or done.",
  });
});
