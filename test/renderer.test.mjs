import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInContext } from "node:vm";
import { http, next, thread } from "./fixtures.mjs";
import { renderer, script, html, styles, settle } from "./renderer-fixtures.mjs";

test("renderer public controls survive bundling and minification", async () => {
  const ui = await renderer({
    initialRows: [thread("1"), thread("2")],
    release: { status: "available", latestVersion: "2.0.0", prompt: "Install the verified v2.0.0 package." },
  });
  try {
    assert.equal(ui.document.querySelectorAll("article").length, 2);
    assert.deepEqual(ui.ids.get("groups").querySelectorAll("a").map(link => link.textContent),
      ["Synthetic notification 1", "Synthetic notification 2"]);
    assert.deepEqual(ui.ids.get("groups").querySelectorAll(".notification-type")
      .map(node => node.textContent), ["Pull Request #42", "Pull Request #42"]);
    await ui.ids.get("copy-update").events.click();
    assert.deepEqual(ui.copied, ["Install the verified v2.0.0 package."]);
    ui.ids.get("theme").value = "dark";
    ui.ids.get("theme").events.change();
    await settle();
    assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
    ui.ids.get("auto-open").events.click();
    await settle();
    assert.equal(ui.ids.get("auto-open").attributes["aria-checked"], "true");
    ui.ids.get("group-by").value = "none";
    ui.ids.get("group-by").events.change();
    await settle();
    assert.equal(ui.ids.get("collapse").hidden, true);
    assert.equal(ui.document.querySelectorAll("article").length, 2);
    ui.ids.get("group-by").value = "repo";
    ui.ids.get("group-by").events.change();
    await settle();
    await ui.ids.get("force-refresh").events.click();
    ui.advance();
    await ui.fireTimer();
    assert.equal(ui.inbox.summary().status, "ready");
    const search = ui.ids.get("search");
    search.value = "notification 2";
    search.events.input();
    await ui.fireTimer(250);
    assert.equal(ui.document.querySelectorAll("article").length, 1);
    assert.equal(ui.ids.get("count").textContent, "2 unread \u00b7 1 matching");
    await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "2").events.click();
    assert.deepEqual(ui.patches, ["/notifications/threads/2"]);
    search.value = "";
    search.events.input();
    await ui.fireTimer(250);
    assert.equal(ui.ids.get("count").textContent, "1 unread");
    assert.equal(ui.document.querySelectorAll("article").length, 1);
  } finally {
    ui.window.events.pagehide();
  }
  assert.equal(ui.timers.size, 0);
});

test("update banner sits below the subtitle and above the inbox controls with its prompt collapsed", () => {
  const positions = ['class="subtitle"', 'id="update-banner"', 'class="toolbar"', 'id="count"', 'id="groups"']
    .map(marker => html.indexOf(marker));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
  assert.match(html, /<details id="update-prompt-details">/);
});

test("Settings combines the running version and update status in one text row below Check for updates", async () => {
  assert.match(html, /<button id="check-updates"[^>]*>Check for updates<\/button>\s*<p class="settings-help"><span id="installed-version">[^<]*<\/span><span id="update-status"[^>]*><\/span><\/p>/);
  assert.doesNotMatch(html, /id="canvas-version"/);
  for (const [release, message] of [
    [{}, "Up to date"],
    [{ status: "available", latestVersion: "0.2.0", prompt: "Synthetic update prompt" }, "Update available: v0.2.0."],
    [{ status: "unchecked", checking: true, checkedAt: null }, "Checking..."],
    [{ status: "unchecked", error: "Release check failed", checkedAt: null }, "Release check failed"],
    [{ status: "unchecked", checkedAt: null }, ""],
  ]) {
    const ui = await renderer({ release });
    const version = ui.ids.get("installed-version");
    const status = ui.ids.get("update-status");
    assert.equal(version.textContent, "Notifications Canvas v0.1.0");
    assert.equal(status.textContent, message ? ` - ${message}` : "");
    assert.equal(status.hidden, !message);
    assert.equal(version.textContent + status.textContent, `Notifications Canvas v0.1.0${message ? ` - ${message}` : ""}`);
  }
});

test("the footer shows source version and branch as text, but stays hidden for release builds", async () => {
  assert.match(html, /<p id="development-build" hidden><\/p>/);
  for (const development of [null, { version: "1.2.3", branch: "feature/<img-src=x>" },
    { version: "1.2.3", branch: "detached HEAD" }, { version: "1.2.3", branch: "branch unavailable" }]) {
    const ui = await renderer({ development });
    const label = ui.ids.get("development-build");
    const expected = development ? `dev (v1.2.3) ${development.branch}` : "";
    assert.equal(label.hidden, !development);
    assert.equal(label.textContent, expected);
    assert.deepEqual(label.children, []);
    await ui.ids.get("force-refresh").events.click();
    assert.equal(label.textContent, expected);
    await ui.fireTimer();
    assert.equal(label.textContent, expected);
    ui.window.events.pagehide();
  }
});

test("update banner shows release links and copies a prompt without installing or changing settings", async () => {
  const ui = await renderer({ release: {
    status: "available", latestVersion: "0.2.0", prompt: "Synthetic safe update prompt",
    releaseUrl: "https://github.com/fletchto99/copilot-notifications-canvas/releases/tag/v0.2.0",
  } });
  assert.equal(ui.ids.get("update-banner").hidden, false);
  assert.match(ui.ids.get("update-title").textContent, /v0\.2\.0.*v0\.1\.0/);
  assert.equal(ui.ids.get("installed-version").textContent, "Notifications Canvas v0.1.0");
  assert.match(ui.ids.get("release-notes").href, /\/releases\/tag\/v0\.2\.0$/);
  assert.match(ui.ids.get("update-instructions").href, /#installation-and-updating$/);
  assert.equal(ui.ids.get("update-prompt").value, "Synthetic safe update prompt");
  const count = ui.calls.length;
  await ui.ids.get("copy-update").events.click();
  assert.deepEqual(ui.copied, ["Synthetic safe update prompt"]);
  assert.equal(ui.calls.length, count);
  assert.match(ui.ids.get("copy-status").textContent, /Copied.*Paste/);
  assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
});

test("clipboard denial exposes a selectable prompt and does not claim it was copied", async () => {
  const ui = await renderer({ clipboardFailure: true, release: {
    status: "available", latestVersion: "0.2.0", prompt: "Manual copy prompt",
  } });
  await ui.ids.get("copy-update").events.click();
  assert.equal(ui.ids.get("update-prompt-details").open, true);
  assert.equal(ui.ids.get("update-prompt").selected, true);
  assert.equal(ui.document.activeElement, ui.ids.get("update-prompt"));
  assert.match(ui.ids.get("copy-status").textContent, /Clipboard unavailable/);
  assert.deepEqual(ui.copied, []);
});

test("current, ahead, absent and failed release checks keep the banner out of the inbox", async () => {
  for (const [status, message] of [
    ["current", /^ - Up to date$/], ["ahead", /Newer than/], ["no_release", /No stable/],
  ]) {
    const ui = await renderer({ release: { status } });
    assert.equal(ui.ids.get("update-banner").hidden, true);
    assert.match(ui.ids.get("update-status").textContent, message);
  }
  const ui = await renderer({ release: { status: "unchecked", error: "Network unavailable", checkedAt: null } });
  assert.equal(ui.ids.get("update-banner").hidden, true);
  assert.equal(ui.ids.get("update-status").textContent, " - Network unavailable");
  assert.equal(ui.ids.get("update-status").hidden, false);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
});

test("a last-known available update stays usable but warns when its latest check failed", async () => {
  const ui = await renderer({ release: {
    status: "available", latestVersion: "0.2.0", prompt: "Synthetic verified update prompt",
    error: "Synthetic release check failure.",
  } });
  assert.equal(ui.ids.get("update-banner").hidden, false);
  assert.match(ui.ids.get("update-title").textContent, /v0\.2\.0.*Last known release; the latest check failed/);
  assert.match(ui.ids.get("update-status").textContent, /Synthetic release check failure/);
  assert.equal(ui.ids.get("notice").hidden, true);
  await ui.ids.get("copy-update").events.click();
  assert.deepEqual(ui.copied, ["Synthetic verified update prompt"]);
  ui.setRelease({ error: null });
  await ui.fireTimer();
  assert.equal(ui.ids.get("update-banner").hidden, false);
  assert.doesNotMatch(ui.ids.get("update-title").textContent, /Last known release/);
  assert.equal(ui.ids.get("update-status").textContent, " - Update available: v0.2.0.");
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
  assert.deepEqual(ui.patches, []);
  ui.window.events.pagehide();
});

test("manual release checks stay available while checking and immediately after a result", async () => {
  const ui = await renderer({ onUpdates: async () => ({
    currentVersion: "0.1.0", latestVersion: null, checking: true, status: "unchecked",
    canCheckAt: 0, checkedAt: null,
  }) });
  assert.doesNotMatch(html, /id="check-updates"[^>]*\bdisabled\b/);
  assert.equal(ui.ids.get("check-updates").disabled, false);
  await ui.ids.get("check-updates").events.click();
  assert.equal(ui.calls.at(-1).path, "/api/updates");
  assert.equal(ui.calls.at(-1).options.body, "{}");
  assert.equal(ui.ids.get("check-updates").disabled, false);
  assert.equal(ui.ids.get("check-updates").attributes["aria-busy"], "true");
  assert.equal(ui.ids.get("update-status").textContent, " - Checking...");
  assert.equal(ui.ids.get("search").disabled, false);
  await ui.ids.get("check-updates").events.click();
  assert.equal(ui.calls.filter(call => call.path === "/api/updates").length, 2);
  ui.setRelease({ checking: false, status: "current", latestVersion: "0.1.0", checkedAt: ui.advance(0) });
  await ui.fireTimer();
  assert.equal(ui.ids.get("update-status").textContent, " - Up to date");
  assert.equal(ui.ids.get("check-updates").attributes["aria-busy"], "false");
  assert.equal(ui.ids.get("check-updates").disabled, false);
  await ui.ids.get("check-updates").events.click();
  assert.equal(ui.calls.filter(call => call.path === "/api/updates").length, 3);
});

test("GitHub retry delays are explained without disabling the manual check button", async () => {
  const ui = await renderer({ release: {
    error: "GitHub declined the release check.", canCheckAt: Date.now() + 7_200_000,
  } });
  assert.match(ui.ids.get("update-status").textContent, /GitHub declined.*Retry after/);
  assert.equal(ui.ids.get("check-updates").disabled, false);
  await ui.ids.get("check-updates").events.click();
  assert.equal(ui.calls.at(-1).path, "/api/updates");
  assert.match(ui.ids.get("update-status").textContent, /Retry after/);
  assert.equal(ui.ids.get("check-updates").disabled, false);
});

test("release check request failures are visible and hidden panels never trigger manual checks", async () => {
  for (const initialOffline of [false, true]) {
    const ui = await renderer({ initialOffline });
    ui.setOffline(true);
    await ui.ids.get("check-updates").events.click();
    assert.match(ui.ids.get("update-status").textContent, /Synthetic connection failure/);
    assert.equal(ui.ids.get("update-status").hidden, false);
    ui.setOffline(false);
    await ui.ids.get("check-updates").events.click();
    assert.doesNotMatch(ui.ids.get("update-status").textContent, /Synthetic connection failure/);
    ui.intersect(false);
    const count = ui.calls.length;
    await ui.ids.get("check-updates").events.click();
    assert.equal(ui.calls.length, count);
  }
});

test("renderer fetches with a capability, renders untrusted titles as text and exposes accessible controls", async () => {
  const ui = await renderer();
  const refresh = ui.calls.find(call => call.path === "/api/refresh");
  assert.ok(refresh);
  assert.equal(refresh.options.headers.Authorization, `Bearer ${"a".repeat(64)}`);
  assert.equal(refresh.options.credentials, "omit");
  const links = ui.document.querySelectorAll("a");
  assert.equal(links[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(links[0].href, "https://github.com/notifications");
  assert.equal(links[0].rel, "noopener noreferrer");
  assert.equal(ui.ids.has("unread"), false);
  assert.equal(ui.ids.has("all"), false);
  assert.equal(ui.ids.has("refresh"), false);
  assert.equal(ui.ids.get("empty").hidden, true);
  assert.equal(ui.document.querySelectorAll("time")[0].attributes["aria-label"].length > 0, true);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
});

test("HTTP failures use the server message or status fallback without discarding the inbox", async t => {
  for (const [body, message] of [
    [{ error: { message: "Synthetic request denied." } }, "Synthetic request denied."],
    [{ error: {} }, "Canvas returned HTTP 503."],
    [{}, "Canvas returned HTTP 503."],
  ]) {
    await t.test(JSON.stringify(body), async () => {
      const ui = await renderer();
      const fetch = ui.context.fetch;
      ui.context.fetch = (path, options) => path === "/api/refresh"
        ? { ok: false, status: 503, json: async () => body }
        : fetch(path, options);
      try {
        await ui.ids.get("force-refresh").events.click();
        assert.equal(ui.ids.get("notice").hidden, false);
        assert.equal(ui.ids.get("notice").textContent, `Showing previously loaded notifications. ${message}`);
        assert.equal(ui.document.querySelectorAll("article").length, 1);
        assert.deepEqual(ui.patches, []);
      } finally {
        ui.context.fetch = fetch;
      }
      await ui.ids.get("force-refresh").events.click();
      assert.equal(ui.ids.get("notice").hidden, true);
      ui.window.events.pagehide();
    });
  }
});

test("poll timeouts are retryable while hiding or closing aborts silently and clears request timers", async t => {
  for (const action of ["timeout", "hide", "close"]) {
    await t.test(action, async () => {
      const ui = await renderer();
      const fetch = ui.context.fetch;
      let started;
      let signal;
      const ready = new Promise(resolve => { started = resolve; });
      ui.context.fetch = (path, options) => {
        if (path !== "/api/state") return fetch(path, options);
        signal = options.signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort",
            () => reject(Object.assign(new Error("Synthetic abort"), { name: "AbortError" })), { once: true });
          started();
        });
      };
      const polling = ui.fireTimer();
      try {
        await ready;
        assert.equal(signal.aborted, false);
        if (action === "timeout") await ui.fireTimer(35_000);
        else if (action === "hide") {
          ui.document.hidden = true;
          ui.document.events.visibilitychange();
        } else ui.window.events.pagehide();
        await polling;
        assert.equal(signal.aborted, true);
        assert.equal([...ui.timers.values()].some(timer => timer.delay === 35_000), false);
        assert.equal(ui.document.querySelectorAll("article").length, 1);
        if (action === "timeout") {
          assert.match(ui.ids.get("notice").textContent, /request timed out.*retries automatically/);
          assert.ok([...ui.timers.values()].some(timer => timer.delay === 5000));
        } else {
          assert.equal(ui.ids.get("notice").hidden, true);
          assert.equal(ui.timers.size, 0);
        }
        assert.deepEqual(ui.patches, []);
      } finally {
        ui.context.fetch = fetch;
        ui.window.events.pagehide();
        await polling;
      }
    });
  }
});

test("issue and PR numbers appear in metadata in every grouping and search without changing mark-read IDs", async () => {
  for (const groupBy of ["repo", "date", "none"]) {
    const ui = await renderer({ storedSettings: { groupBy }, initialRows: [
      thread("101", { subject: {
        title: "<img src=x onerror=alert(1)> Fix login", type: "Issue",
        url: "https://api.github.com/repos/example/widgets/issues/7",
      } }),
      thread("102", { subject: {
        title: "", type: "PullRequest", url: "https://api.github.com/repos/example/widgets/pulls/8",
      } }),
      thread("103", { subject: {
        title: "New release", type: "Release", url: "https://api.github.com/repos/example/widgets/releases/9",
      } }),
    ] });
    try {
      const groups = ui.ids.get("groups");
      assert.deepEqual(groups.querySelectorAll("a").map(link => link.textContent),
        ["<img src=x onerror=alert(1)> Fix login", "(Untitled notification)", "New release"]);
      assert.deepEqual(groups.querySelectorAll(".notification-type").map(node => node.textContent),
      ["Issue #7", "Pull Request #8", "Release"]);
      assert.deepEqual(groups.querySelectorAll("a").map(link => link.href),
        ["https://github.com/example/widgets/issues/7", "https://github.com/example/widgets/pull/8",
          "https://github.com/example/widgets/releases"]);
      assert.deepEqual(groups.querySelectorAll("button").filter(button => button.dataset.threadId)
        .map(button => button.attributes["aria-label"]), [
        "Mark as read: #7 <img src=x onerror=alert(1)> Fix login",
        "Mark as done: #7 <img src=x onerror=alert(1)> Fix login",
        "Mark as read: #8 Untitled notification", "Mark as done: #8 Untitled notification",
        "Mark as read: New release", "Mark as done: New release",
      ]);
      const search = ui.ids.get("search");
      search.value = "#7";
      search.events.input();
      await ui.fireTimer(250);
      assert.equal(groups.querySelectorAll("article").length, 1);
      assert.equal(ui.ids.get("count").textContent, "3 unread \u00b7 1 matching");
      await groups.querySelectorAll("button").find(button => button.dataset.threadId === "101").events.click();
      assert.deepEqual(ui.patches, ["/notifications/threads/101"]);
    } finally {
      ui.window.events.pagehide();
    }
  }
});

test("canvas is titled Unread Notifications without mode tabs or the old All notice", () => {
  assert.match(html, /<title>Unread Notifications<\/title>/);
  assert.match(html, /<h1>Unread Notifications<\/h1>/);
  assert.doesNotMatch(html, /id="(?:all|unread|api-limit)"/);
});

test("inbox status leads with unread counts and adds matching counts only while searching", async () => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  assert.equal(ui.ids.get("count").textContent, "2 unread");
  assert.equal(ui.ids.get("count").hidden, false);
  assert.equal(ui.ids.has("coverage"), false);
  assert.doesNotMatch(script, /End of the available inbox|notifications loaded\./);
  assert.doesNotMatch(styles, /(?:^|\n)footer \{[^}]*border-top:/);
  await runInContext('update("filters", { query: "notification 1" })', ui.context);
  assert.equal(ui.ids.get("count").textContent, "2 unread \u00b7 1 matching");
  await runInContext('update("filters", { query: "no match" })', ui.context);
  assert.equal(ui.ids.get("count").textContent, "2 unread \u00b7 0 matching");
  assert.equal(ui.ids.get("count").hidden, false);
  await runInContext('update("filters", { query: "" })', ui.context);
  assert.equal(ui.ids.get("count").textContent, "2 unread");
  assert.match(html, /id="count"[^>]*title="Counts include loaded notifications only\."/);
  assert.match(html, /Search loaded notification titles, issue or PR numbers, and repositories/);
  ui.window.events.pagehide();
});

test("counts return when notifications arrive and hide after the last read without moving toolbar controls", async () => {
  const ui = await renderer({ initialRows: [] });
  const search = ui.ids.get("search");
  const settings = ui.ids.get("settings");
  assert.equal(ui.ids.get("count").hidden, true);
  assert.equal(search.hidden, false);
  assert.equal(search.disabled, false);
  assert.equal(settings.hidden, false);
  ui.setRows([thread("1")]);
  await ui.ids.get("force-refresh").events.click();
  assert.equal(ui.ids.get("count").hidden, false);
  assert.equal(ui.ids.get("count").textContent, "1 unread");
  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1").events.click();
  assert.equal(ui.ids.get("count").hidden, true);
  assert.equal(ui.ids.get("collapse").hidden, true);
  assert.equal(ui.ids.get("empty").hidden, false);
  assert.equal(ui.ids.get("search"), search);
  assert.equal(ui.ids.get("settings"), settings);
  assert.equal(search.hidden, false);
  assert.equal(search.disabled, false);
  assert.equal(settings.hidden, false);
});

test("Load more still fetches another page of 50 and disappears when the inbox ends", async () => {
  const first = Array.from({ length: 50 }, (_, index) => thread(String(index + 1)));
  const second = Array.from({ length: 50 }, (_, index) => thread(String(index + 51)));
  const ui = await renderer({ onFetch: args => args.at(-1).includes("page=1") ?
    http(first, { link: next }) : http(second) });
  const more = ui.ids.get("more");
  assert.equal(ui.document.querySelectorAll("article").length, 50);
  assert.equal(more.hidden, false);
  assert.equal(more.disabled, false);
  assert.equal(more.textContent, "Load more (up to 50)");
  await more.events.click();
  assert.equal(ui.document.querySelectorAll("article").length, 100);
  assert.equal(more.hidden, true);
  assert.equal(ui.githubCalls.length, 2);
  assert.ok(ui.githubCalls.every(args => args.at(-1).includes("per_page=50")));
  ui.window.events.pagehide();
});

test("Load more explains when a refresh is needed after a read", async () => {
  const ui = await renderer({ onFetch: () => http([thread("1"), thread("2")], { link: next }) });
  await ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.threadId === "1").events.click();
  assert.equal(ui.ids.get("more").disabled, true);
  assert.equal(ui.ids.get("more").title, "Refresh notifications before loading more.");
  ui.window.events.pagehide();
});

test("Force refresh is an accessible, always-enabled icon immediately before Settings", async () => {
  assert.doesNotMatch(html, /id="refresh"|>Refresh<\/button>|class="heading"/);
  const button = html.match(/<button\b([^>]*\bid="force-refresh"[^>]*)>([\s\S]*?)<\/button>/);
  assert.ok(button);
  assert.match(button[1], /class="icon-button"/);
  assert.match(button[1], /aria-label="Force refresh"/);
  assert.match(button[1], /aria-describedby="refresh-tooltip"/);
  assert.doesNotMatch(button[1], /\btitle=/);
  assert.match(button[2], /<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(button[2], /^\s*<svg\b[^>]*>\s*<path\b[^>]*\/>\s*<\/svg>\s*$/);
  assert.match(html, /<div id="refresh-control" class="tooltip-anchor">[\s\S]*?<\/div>\s*<details id="settings"/);
  assert.match(html, /id="refresh-tooltip"[^>]*role="tooltip"/);
  assert.match(styles, /\.tooltip-anchor:not\(\[data-tooltip-dismissed\]\):is\(:hover, :focus-within\) > \.tooltip \{ visibility: visible; \}/);
  assert.doesNotMatch(script, /\$\("force-refresh"\)\.(?:disabled|textContent)\s*=/);
  assert.match(styles, /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*#force-refresh\[aria-busy="true"\] svg \{ animation: refresh-spin/);
  const extension = await readFile(new URL("../src/extension.mjs", import.meta.url), "utf8");
  assert.match(extension, /name: "refresh"/);
  const ui = await renderer();
  assert.equal(ui.ids.get("force-refresh").disabled, false);
  assert.ok(ui.calls.some(call => call.path === "/api/refresh"));
  assert.equal(ui.githubCalls.length, 1);
  assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Last updated 0 seconds ago");
});

test("the refresh tooltip reports elapsed whole seconds on hover and focus without fetching", async () => {
  const ui = await renderer();
  const button = ui.ids.get("force-refresh");
  const tooltip = ui.ids.get("refresh-tooltip-text");
  const calls = ui.calls.length;
  ui.advance(999);
  button.events.pointerenter();
  assert.equal(tooltip.textContent, "Last updated 0 seconds ago");
  ui.advance(1);
  button.events.focus();
  assert.equal(tooltip.textContent, "Last updated 1 second ago");
  ui.advance(60_000);
  button.events.pointerenter();
  assert.equal(tooltip.textContent, "Last updated 61 seconds ago");
  assert.equal(ui.calls.length, calls);
  await runInContext("state.lastFetchedAt = Date.now() + 1000; render()", ui.context);
  assert.equal(tooltip.textContent, "Last updated 0 seconds ago");
  await runInContext("state.lastFetchedAt = 0; render()", ui.context);
  assert.match(tooltip.textContent, /^Last updated \d+ seconds ago$/);
  await runInContext("state.lastFetchedAt = null; render()", ui.context);
  assert.equal(tooltip.textContent, "Not updated yet");
});

test("the refresh tooltip updates every 15 seconds independently of state polling", async () => {
  const ui = await renderer();
  const tooltip = ui.ids.get("refresh-tooltip-text");
  for (const seconds of [15, 30, 45]) {
    ui.advance(14_999);
    await ui.fireTimer();
    assert.equal(tooltip.textContent, `Last updated ${seconds - 15} seconds ago`);
    const calls = ui.calls.length;
    ui.advance(1);
    await ui.fireTimer(15_000);
    assert.equal(tooltip.textContent, `Last updated ${seconds} seconds ago`);
    assert.equal(ui.calls.length, calls, "the tooltip timer must not make any requests");
    assert.equal(ui.githubCalls.length, 1);
    assert.equal([...ui.timers.values()].filter(timer => timer.delay === 15_000).length, 1);
  }
  ui.window.events.pagehide();
  assert.equal(ui.timers.size, 0);
});

test("the tooltip timer stops when hidden or closed and restarts once on foreground return", async () => {
  const ui = await renderer();
  ui.document.hidden = true;
  ui.document.events.visibilitychange();
  assert.equal(ui.timers.size, 0);
  ui.advance(15_000);
  await runInContext("tickTooltip()", ui.context);
  assert.equal(ui.timers.size, 0);
  ui.document.hidden = false;
  ui.document.events.visibilitychange();
  await settle();
  ui.document.events.visibilitychange();
  await settle();
  assert.equal([...ui.timers.values()].filter(timer => timer.delay === 15_000).length, 1);
  ui.intersect(false);
  assert.equal(ui.timers.size, 0);
  ui.intersect(true);
  await settle();
  assert.equal([...ui.timers.values()].filter(timer => timer.delay === 15_000).length, 1);
  ui.window.events.pagehide();
  await runInContext("tickTooltip()", ui.context);
  assert.equal(ui.timers.size, 0);
});

test("the tooltip age continues updating during an outstanding refresh", async () => {
  let release;
  let fetches = 0;
  const ui = await renderer({ onFetch: () => ++fetches === 1 ? http([thread()])
    : new Promise(resolve => { release = () => resolve(http([thread()])); }) });
  const refreshing = ui.ids.get("force-refresh").events.click();
  await settle();
  try {
    ui.advance(15_000);
    const calls = ui.calls.length;
    await ui.fireTimer(15_000);
    assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Refreshing. Last updated 15 seconds ago");
    assert.equal(ui.calls.length, calls);
  } finally {
    release();
    await refreshing;
    ui.window.events.pagehide();
  }
});

test("Escape dismisses the refresh tooltip until the next hover or focus", async () => {
  const ui = await renderer();
  const button = ui.ids.get("force-refresh");
  button.focus();
  button.events.focus();
  assert.equal(ui.ids.get("refresh-control").dataset.tooltipDismissed, undefined);
  ui.document.events.keydown({ key: "Escape" });
  assert.equal(ui.ids.get("refresh-control").dataset.tooltipDismissed, "true");
  assert.equal(ui.document.activeElement, button);
  await runInContext("render()", ui.context);
  assert.equal(ui.ids.get("refresh-control").dataset.tooltipDismissed, "true");
  button.events.pointerenter();
  assert.equal(ui.ids.get("refresh-control").dataset.tooltipDismissed, undefined);
  ui.document.events.keydown({ key: "Escape" });
  button.events.focus();
  assert.equal(ui.ids.get("refresh-control").dataset.tooltipDismissed, undefined);
  ui.document.events.keydown({ key: "Enter" });
  assert.equal(ui.ids.get("refresh-control").dataset.tooltipDismissed, undefined);
});

test("failed updates keep the last successful update time in the refresh tooltip", async () => {
  let fetches = 0;
  const ui = await renderer({ onFetch: () => ++fetches === 1 ? http([thread()]) : http({}, {}, 500) });
  ui.advance(15_000);
  await ui.ids.get("force-refresh").events.click();
  assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Last updated 15 seconds ago");
  assert.equal(ui.ids.get("notice").hidden, false);
  ui.advance(15_000);
  await ui.fireTimer(15_000);
  assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Last updated 30 seconds ago");
});

test("an initial GitHub error does not claim a successful update in the tooltip", async () => {
  const ui = await renderer({ onFetch: () => http({}, {}, 401) });
  assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Not updated yet");
  assert.equal(ui.inbox.summary().nextRefreshAt - ui.advance(0), 120_000);
  assert.equal(ui.ids.get("notice").hidden, false);
});

test("the footer retains only development metadata, with no refresh line or controls", () => {
  const footer = html.match(/<footer>([\s\S]*?)<\/footer>/)?.[1];
  assert.ok(footer);
  assert.match(footer, /^\s*<p id="development-build" hidden><\/p>\s*$/);
  assert.doesNotMatch(html + script + styles, /id="updated"|\$\("updated"\)|refresh-link|refresh-status|refresh-actions/);
  assert.match(styles, /footer:has\(#development-build\[hidden\]\) \{ display: none; \}/);
  assert.doesNotMatch(html + script + styles, /read-help|footer-links|Mark-as-read help|Mark as read applies/);
});

test("Force refresh checks GitHub immediately, preserves focus and still leaves automatic polling gated", async () => {
  const ui = await renderer();
  const button = ui.ids.get("force-refresh");
  button.focus();
  ui.setRows([thread("1"), thread("2")]);
  await button.events.click();
  assert.equal(ui.githubCalls.length, 2);
  assert.equal(ui.calls.at(-1).options.body, '{"force":true}');
  assert.equal(ui.document.querySelectorAll("article").length, 2);
  assert.equal(ui.document.activeElement, button);
  assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Last updated 0 seconds ago");
  assert.equal(button.attributes["aria-busy"], "false");
  await button.events.click();
  assert.equal(ui.githubCalls.length, 3);
  ui.advance(59_999);
  await ui.fireTimer();
  assert.equal(ui.githubCalls.length, 3);
  ui.advance(1);
  await ui.fireTimer();
  assert.equal(ui.githubCalls.length, 4);
});

test("clicks during a refresh stay enabled and coalesce into one follow-up refresh", async () => {
  let fetches = 0;
  let release;
  const ui = await renderer({ onFetch: () => ++fetches === 2 ?
    new Promise(resolve => { release = () => resolve(http([thread()])); }) : http([thread()]) });
  const button = ui.ids.get("force-refresh");
  button.focus();
  const refreshing = button.events.click();
  await settle();
  assert.equal(button.disabled, false);
  assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Refreshing. Last updated 0 seconds ago");
  assert.equal(button.attributes["aria-busy"], "true");
  await button.events.click();
  await button.events.click();
  assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Refresh queued. Last updated 0 seconds ago");
  assert.equal(fetches, 2);
  release();
  await refreshing;
  await settle();
  assert.equal(fetches, 3);
  assert.equal(button.disabled, false);
  assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Last updated 0 seconds ago");
  assert.equal(button.attributes["aria-busy"], "false");
  assert.equal(ui.document.activeElement, button);
});

test("Force refresh waits for a local poll instead of losing the click or accepting its stale snapshot", async () => {
  let release;
  const ui = await renderer({ onState: () => new Promise(resolve => { release = resolve; }) });
  const polling = ui.fireTimer();
  await settle();
  ui.setRows([thread("2")]);
  const button = ui.ids.get("force-refresh");
  const refreshing = button.events.click();
  assert.equal(button.disabled, false);
  assert.equal(ui.githubCalls.length, 1);
  release();
  await polling;
  await refreshing;
  assert.equal(ui.githubCalls.length, 2);
  assert.equal(ui.document.querySelectorAll("a")[0].textContent, "Synthetic notification 2");
});

test("manual and foreground refreshes queue behind row and repository writes without interrupting them", async () => {
  for (const [kind, trigger] of [["row", "manual"], ["repository", "manual"],
    ["row", "foreground"], ["repository", "foreground"]]) {
    let release;
    const ui = await renderer({
      initialRows: [thread("1"), thread("2")],
      onWrite: (_path, count) => count === 1
        ? new Promise(resolve => { release = () => resolve("HTTP/2 205 Reset Content\r\n\r\n"); })
        : "HTTP/2 205 Reset Content\r\n\r\n",
    });
    const read = ui.ids.get("groups").querySelectorAll("button")
      .find(node => kind === "row" ? node.dataset.threadId : node.dataset.repository);
    const reading = read.events.click();
    await settle();
    const button = ui.ids.get("force-refresh");
    if (trigger === "manual") await button.events.click();
    else {
      ui.intersect(false);
      ui.intersect(true);
      await settle();
    }
    assert.equal(button.disabled, false);
    assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Refresh queued. Last updated 0 seconds ago");
    assert.equal(ui.calls.filter(call => call.path === "/api/refresh").length, 1);
    ui.setRows([]);
    release();
    await reading;
    if (kind === "repository") {
      await ui.inbox.batch.done;
      await runInContext("update()", ui.context);
    }
    await settle();
    assert.deepEqual(ui.patches, kind === "row" ? ["/notifications/threads/1"] :
      ["/notifications/threads/1", "/notifications/threads/2"]);
    assert.equal(ui.calls.filter(call => call.path === "/api/refresh").length, 2);
    assert.equal(ui.document.querySelectorAll("article").length, 0);
    assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Last updated 0 seconds ago");
  }
});

test("queued Force refresh preserves the latest search edit during a filter request", async () => {
  let release;
  let filters = 0;
  const ui = await renderer({
    initialRows: [thread("1"), thread("2")],
    onFilters: () => ++filters === 1 ? new Promise(resolve => { release = resolve; }) : undefined,
  });
  const filtering = runInContext('update("filters", { query: "notification 1" })', ui.context);
  await settle();
  const search = ui.ids.get("search");
  search.value = "notification 2";
  search.events.input();
  const button = ui.ids.get("force-refresh");
  await button.events.click();
  assert.equal(button.disabled, false);
  assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Refresh queued. Last updated 0 seconds ago");
  release();
  await filtering;
  await settle();
  assert.equal(ui.githubCalls.length, 2);
  assert.equal(ui.inbox.filters.query, "notification 2");
  assert.equal(search.value, "notification 2");
  assert.equal(ui.document.querySelectorAll("a")[0].textContent, "Synthetic notification 2");
});

test("Force refresh remains clickable during GitHub backoff and reports the wait without retrying upstream", async () => {
  let fetches = 0;
  const ui = await renderer({ onFetch: () => ++fetches === 2 ?
    http({}, { "retry-after": "600" }, 429) : http([thread()]) });
  const button = ui.ids.get("force-refresh");
  await button.events.click();
  assert.equal(ui.ids.get("notice").hidden, false);
  assert.match(ui.ids.get("notice").textContent, /rate limit/);
  assert.equal(button.disabled, false);
  await button.events.click();
  assert.equal(fetches, 2);
  assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Last updated 0 seconds ago");
  assert.equal(button.disabled, false);
  ui.advance(600_000);
  await button.events.click();
  assert.equal(fetches, 3);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(button.attributes["aria-busy"], "false");
});

test("automatic polling refreshes at 60 seconds, never before, and repeats on that cadence", async () => {
  const ui = await renderer();
  for (let refreshes = 1; refreshes <= 2; refreshes++) {
    ui.advance(59_999);
    await ui.fireTimer();
    assert.equal(ui.calls.at(-1).path, "/api/state");
    assert.equal(ui.githubCalls.length, refreshes);
    assert.equal(ui.inbox.summary().nextRefreshAt - ui.advance(0), 1);
    ui.advance(1);
    await ui.fireTimer();
    assert.equal(ui.calls.at(-1).path, "/api/refresh");
    assert.equal(ui.calls.at(-1).options.body, "{}");
    assert.equal(ui.githubCalls.length, refreshes + 1);
    assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Last updated 0 seconds ago");
  }
  ui.window.events.pagehide();
});

test("60-second refreshes pause while hidden or non-intersecting and resume when visible", async () => {
  for (const mode of ["hidden", "non-intersecting"]) {
    const ui = await renderer();
    const setVisible = value => {
      if (mode === "hidden") {
        ui.document.hidden = !value;
        ui.document.events.visibilitychange();
      } else {
        ui.intersect(value);
      }
    };
    setVisible(false);
    ui.advance(60_000);
    assert.equal(ui.timers.size, 0);
    await runInContext("tick()", ui.context);
    assert.equal(ui.githubCalls.length, 1);
    setVisible(true);
    await settle();
    assert.equal(ui.githubCalls.length, 2);
    ui.window.events.pagehide();
    ui.advance(60_000);
    await runInContext("tick()", ui.context);
    assert.equal(ui.githubCalls.length, 2);
    assert.equal(ui.timers.size, 0);
  }
});

test("returning to foreground refreshes immediately before the interval, without duplicate visibility requests", async () => {
  const ui = await renderer({ onFetch: () => http([thread()], { "x-poll-interval": "300" }) });
  ui.intersect(true);
  ui.document.events.visibilitychange();
  await settle();
  assert.equal(ui.githubCalls.length, 1);

  ui.document.hidden = true;
  ui.document.events.visibilitychange();
  ui.intersect(false);
  ui.advance(1000);
  ui.document.hidden = false;
  ui.document.events.visibilitychange();
  await settle();
  assert.equal(ui.githubCalls.length, 1);
  ui.intersect(true);
  ui.document.events.visibilitychange();
  ui.intersect(true);
  await settle();
  assert.equal(ui.githubCalls.length, 2);
  const refreshes = ui.calls.filter(call => call.path === "/api/refresh");
  assert.equal(refreshes.length, 2);
  assert.equal(refreshes[1].options.body, '{"force":true}');
  assert.equal(ui.inbox.summary().nextRefreshAt, ui.advance(0) + 300_000);
  ui.document.events.visibilitychange();
  await settle();
  assert.equal(ui.githubCalls.length, 2);
  ui.window.events.pagehide();
});

test("returning to foreground cannot bypass rate limits or error backoff", async () => {
  for (const response of [
    http({}, {}, 401),
    http({}, { "retry-after": "600" }, 429),
    http([thread()], { "x-ratelimit-remaining": "0" }),
  ]) {
    let fetches = 0;
    const ui = await renderer({ onFetch: () => ++fetches === 1 ? response : http([thread()]) });
    const deadline = ui.inbox.summary().nextRefreshAt;
    ui.intersect(false);
    ui.advance(1000);
    ui.intersect(true);
    await settle();
    assert.equal(fetches, 1);
    assert.equal(ui.ids.get("notice").hidden, false);
    assert.equal(ui.ids.get("force-refresh").attributes["aria-busy"], "false");
    ui.advance(deadline - ui.advance(0));
    await ui.fireTimer();
    assert.equal(fetches, 2);
    assert.equal(ui.ids.get("notice").hidden, true);
    ui.window.events.pagehide();
  }
});

test("automatic polling honors a longer GitHub interval and resumes only when visible", async () => {
  const ui = await renderer({ onFetch: () => http([thread()], { "x-poll-interval": "300" }) });
  assert.equal(ui.ids.get("refresh-tooltip-text").textContent, "Last updated 0 seconds ago");
  assert.equal(ui.inbox.summary().nextRefreshAt - ui.advance(0), 300_000);
  ui.advance(120_000);
  await ui.fireTimer();
  assert.equal(ui.githubCalls.length, 1);
  ui.advance(179_999);
  await ui.fireTimer();
  assert.equal(ui.githubCalls.length, 1);
  ui.advance(1);
  await ui.fireTimer();
  assert.equal(ui.githubCalls.length, 2);
  ui.intersect(false);
  ui.advance(300_000);
  assert.equal(ui.timers.size, 0);
  await runInContext("tick()", ui.context);
  assert.equal(ui.githubCalls.length, 2);
  ui.intersect(true);
  await settle();
  assert.equal(ui.githubCalls.length, 3);
});

test("an empty inbox ends the caught-up heading with a party popper and hides the blue icon tile", async () => {
  const ui = await renderer({ initialRows: [] });
  assert.equal(ui.ids.get("empty").hidden, false);
  assert.equal(ui.ids.get("empty-title").textContent, "All caught up \u{1F389}");
  assert.equal(ui.ids.get("empty-symbol").hidden, true);
  assert.equal(ui.ids.get("count").hidden, true);
  assert.match(styles, /\.empty \{[^}]*border: 1px dashed var\(--border\);[^}]*border-radius: 10px;/);
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none !important;/);
  assert.match(html, /<div id="empty-symbol" class="empty-symbol" aria-hidden="true">\/<\/div>/);
});

test("loading, search and unavailable states restore the original icon tile without a celebration", async () => {
  for (const setup of [
    'state.status = "idle"',
    'state.status = "loading"',
    'state.filters.query = "no match"',
    'state.error = { message: "GitHub unavailable" }',
    'connectionError = "Connection unavailable"',
    'state = undefined; connectionError = "Connection unavailable"',
  ]) {
    const ui = await renderer({ initialRows: [] });
    await runInContext(`${setup}; render()`, ui.context);
    assert.equal(ui.ids.get("empty-symbol").hidden, false, setup);
    assert.equal(ui.ids.get("count").hidden, false, setup);
    assert.doesNotMatch(ui.ids.get("empty-title").textContent, /\u{1F389}/u, setup);
  }
});

test("authentication errors remain visible and automatically retry after backoff", async () => {
  let fetches = 0;
  const ui = await renderer({ onFetch: () => ++fetches === 2 ? http({}, {}, 401) : http([thread()]) });
  ui.advance();
  await ui.fireTimer();
  assert.equal(ui.ids.get("notice").hidden, false);
  assert.match(ui.ids.get("notice").textContent, /gh auth login/);
  assert.match(ui.ids.get("empty-description").textContent, /retries automatically/);
  ui.advance(119_999);
  await ui.fireTimer();
  assert.equal(fetches, 2);
  ui.advance(1);
  await ui.fireTimer();
  assert.equal(fetches, 3);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.inbox.summary().status, "ready");
});

test("an offline initial open recovers automatically without needing a manual refresh", async () => {
  const ui = await renderer({ initialOffline: true });
  assert.equal(ui.ids.get("notice").hidden, false);
  assert.equal(ui.ids.get("empty-title").textContent, "Your inbox is unavailable");
  assert.match(ui.ids.get("empty-description").textContent, /retries automatically.*Reopen/);
  assert.equal(ui.githubCalls.length, 0);
  ui.setOffline(false);
  await ui.fireTimer();
  assert.equal(ui.githubCalls.length, 1);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
});

test("search typed during automatic loading is applied after the fetch finishes", async () => {
  let requests = 0;
  let release;
  const ui = await renderer({ onFetch: () => ++requests === 1 ? http([thread()]) :
    new Promise(resolve => { release = () => resolve(http([thread("1"), thread("3")])); }) });
  ui.advance();
  const polling = ui.fireTimer();
  await settle();
  const search = ui.ids.get("search");
  search.value = "notification 3";
  search.events.input();
  await ui.fireTimer(250);
  release();
  await polling;
  assert.equal(ui.calls.at(-1).path, "/api/filters");
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  assert.equal(ui.document.querySelectorAll("a")[0].textContent, "Synthetic notification 3");
});

test("renderer preserves focus and collapsed groups across unchanged data and updates", async () => {
  const ui = await renderer();
  const firstLink = ui.document.querySelectorAll("a")[0];
  firstLink.focus();
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement, firstLink);
  const group = ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.disclosure);
  group.focus();
  group.events.click();
  assert.equal(group.attributes["aria-expanded"], "false");
  assert.equal(ui.ids.get("collapse").textContent, "Expand all");
  await runInContext("state.groups[0].items[0].title = 'Updated synthetic title'; render()", ui.context);
  assert.equal(ui.ids.get("groups").querySelectorAll("button").find(node => node.dataset.disclosure).attributes["aria-expanded"], "false");
  assert.equal(ui.document.activeElement.dataset.focusKey, "repo:example/widgets");
});

test("an individual repository can expand again without changing another repository or its keyboard focus", async () => {
  const ui = await renderer({ initialRows: [
    thread("1", { repository: { full_name: "example/alpha" } }),
    thread("2", { repository: { full_name: "example/beta" } }),
  ] });
  const groups = ui.ids.get("groups");
  const [first, second] = groups.querySelectorAll("button").filter(button => button.dataset.disclosure);
  first.focus();
  first.events.click();
  assert.equal(first.attributes["aria-expanded"], "false");
  assert.equal(groups.children[0].children[1].hidden, true);
  assert.equal(second.attributes["aria-expanded"], "true");
  first.events.click();
  assert.equal(first.attributes["aria-expanded"], "true");
  assert.equal(groups.children[0].children[1].hidden, false);
  assert.equal(ui.document.activeElement, first);
  await ui.fireTimer();
  assert.equal(first.attributes["aria-expanded"], "true");
  assert.equal(second.attributes["aria-expanded"], "true");
  assert.equal(ui.ids.get("collapse").textContent, "Collapse all");
  assert.equal(ui.document.activeElement, first);
  assert.deepEqual(ui.patches, []);
  ui.window.events.pagehide();
});

test("search and clearing search keep working without mode controls", async () => {
  const ui = await renderer();
  const search = ui.ids.get("search");
  search.value = "no match";
  search.events.input();
  [...ui.timers.values()].find(timer => timer.delay === 250).fn();
  await settle();
  assert.equal(ui.calls.at(-1).path, "/api/filters");
  assert.equal(ui.document.querySelectorAll("article").length, 0);
  assert.equal(ui.ids.get("empty-title").textContent, "No matches in loaded notifications");
  await runInContext('update("filters", { query: "" })', ui.context);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
});

test("hidden/non-intersecting/closed documents do not schedule unnecessary work", async () => {
  const ui = await renderer({ hidden: true });
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.timers.size, 0);
  ui.document.hidden = false;
  ui.document.events.visibilitychange();
  await settle();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.timers.size, 2);
  ui.intersect(false);
  await settle();
  assert.equal(ui.timers.size, 0);
  await runInContext("tick()", ui.context);
  assert.equal(ui.calls.length, 2);
  ui.intersect(true);
  await settle();
  assert.equal(ui.calls.length, 4);
  const resumed = ui.calls.slice(2).find(call => call.path === "/api/refresh");
  assert.ok(resumed);
  assert.equal(resumed.options.body, '{"force":true}');
  ui.window.events.pagehide();
  assert.equal(ui.timers.size, 0);
  await runInContext("tick()", ui.context);
  assert.equal(ui.calls.length, 4);
});

test("a missing capability remains inert and explains how to open the canvas", async () => {
  const ui = await renderer({ token: "" });
  ui.intersect(true);
  ui.document.events.visibilitychange();
  await settle();
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.timers.size, 0);
  assert.match(ui.ids.get("notice").textContent, /Open this canvas from Copilot/);
  assert.equal(ui.ids.get("check-updates").disabled, true);
});
