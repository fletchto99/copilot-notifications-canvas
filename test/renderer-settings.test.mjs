import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInContext } from "node:vm";
import { http, inboxNext as next, thread } from "./fixtures.mjs";
import { renderer, script, html, styles, settle } from "./renderer-fixtures.mjs";

test("the per-panel Web Audio option is replaced by the native notification sound picker", () => {
  assert.doesNotMatch(html, /id="sound"|Play sound|per-panel chime/);
  assert.match(html, /<label for="desktop-sound"/);
  assert.match(html, /<select id="desktop-sound"/);
  assert.doesNotMatch(script, /AudioContext|NotificationSound|sound\.mjs/);
});

test("Sound is a single settings row with a labeled native select and matching focus and disabled styling", async () => {
  const row = [...html.matchAll(/<div class="select-setting">([\s\S]*?)<\/div>/g)]
    .find(([, content]) => content.includes('for="desktop-sound"'));
  assert.ok(row);
  assert.match(row[1], /<label for="desktop-sound">Sound<\/label>/);
  assert.match(row[1], /<select id="desktop-sound"[^>]*aria-describedby="desktop-status"/);
  assert.doesNotMatch(row[1], /<button|role="(?:button|combobox|listbox)"|tabindex/);
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.select-setting \{[^}]*min-height: 38px;[^}]*border-radius: 7px;[^}]*padding: 7px 12px;/);
  assert.match(css, /\.select-setting select \{[^}]*border: 0;[^}]*text-align-last: right;[^}]*appearance: none;/);
  assert.match(css, /\.select-setting::after \{[^}]*pointer-events: none;/);
  assert.match(css, /\.select-setting:focus-within \{[^}]*outline: 2px solid var\(--focus\)/);
  assert.match(css, /\.select-setting:has\(select:disabled\) \{[^}]*opacity: 0?\.55/);
});

test("enabled toggle rows keep neutral text and borders while the switch indicates their state", () => {
  assert.match(styles, /button,\s+input,\s+select,\s+textarea \{\s+font: inherit;\s+color: inherit;\s+\}/);
  assert.match(styles, /(?:^|\n)button \{[^}]*border: 1px solid var\(--border\);/);
  assert.doesNotMatch(styles, /\.settings-panel button\[aria-checked="true"\]/);
  assert.match(styles, /\.switch-toggle\[aria-checked="true"\] \.switch-track \{\s+background: var\(--accent\);\s+\}/);
  assert.match(styles, /\.switch-toggle\[aria-checked="true"\] \.switch-thumb \{\s+transform: translateX\(14px\);\s+\}/);
  assert.match(styles, /:focus-visible \{\s+outline: 2px solid var\(--focus\);\s+outline-offset: 3px;\s+\}/);
});

test("GitHub inbox is an accessible icon link before Refresh and Settings in the toolbar", () => {
  const link = html.match(/<a\b([^>]*\bid="open-inbox"[^>]*)>([\s\S]*?)<\/a>/);
  assert.ok(link);
  const [, attributes, content] = link;
  assert.match(attributes, /class="icon-button"/);
  assert.doesNotMatch(attributes, /\bhref=/);
  assert.match(attributes, /role="link"/);
  assert.match(attributes, /aria-disabled="true"/);
  assert.match(attributes, /tabindex="-1"/);
  assert.match(attributes, /target="_blank"/);
  assert.match(attributes, /rel="noopener noreferrer"/);
  assert.match(attributes, /aria-label="Open GitHub inbox"/);
  assert.match(attributes, /aria-describedby="inbox-tooltip"/);
  assert.doesNotMatch(attributes, /\btitle=/);
  assert.doesNotMatch(attributes, /\bhidden\b/);
  assert.match(content, /<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(content, /^\s*<svg\b[^>]*>\s*<path\b[^>]*\/>\s*<path\b[^>]*\/>\s*<\/svg>\s*$/);
  assert.match(html, /<div class="toolbar">\s*<h1>GitHub Notifications<\/h1>\s*<div id="inbox-control"[^>]*>[\s\S]*?<\/div>\s*<div id="refresh-control"[^>]*>[\s\S]*?<\/div>\s*<details id="settings"/);
  assert.equal([...html.matchAll(/href="https:\/\/github\.com\/notifications"/g)].length, 0);
});

test("Settings uses an icon-only toggle with an accessible name and tooltip", () => {
  const summary = html.match(/<summary\b([^>]*\bid="settings-toggle"[^>]*)>([\s\S]*?)<\/summary>/);
  assert.ok(summary);
  const [, attributes, content] = summary;
  assert.match(attributes, /class="icon-button tooltip-anchor"/);
  assert.match(attributes, /aria-label="Settings"/);
  assert.match(attributes, /aria-describedby="settings-tooltip"/);
  assert.doesNotMatch(attributes, /\btitle=/);
  assert.match(attributes, /aria-controls="settings-panel"/);
  assert.match(attributes, /aria-expanded="false"/);
  assert.match(content, /<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(content, /^\s*<svg\b[^>]*>\s*<path\b[^>]*\/>\s*<circle\b[^>]*\/>\s*<\/svg>\s*<span id="settings-tooltip" class="tooltip" role="tooltip"><span class="tooltip-content">Settings<\/span><\/span>\s*$/);
  assert.match(styles, /\.settings\[open\] > summary > \.tooltip \{\s+display: none;\s+\}/);
});

test("inbox and Settings tooltips share hover, focus and Escape behavior", async () => {
  const ui = await renderer();
  for (const [control, anchor] of [["open-inbox", "inbox-control"], ["settings-toggle", "settings-toggle"]]) {
    ui.ids.get(control).events.pointerenter();
    assert.equal(ui.ids.get(anchor).dataset.tooltipDismissed, undefined);
    ui.document.events.keydown({ key: "Escape" });
    assert.equal(ui.ids.get(anchor).dataset.tooltipDismissed, "true");
    ui.ids.get(control).events.focus();
    assert.equal(ui.ids.get(anchor).dataset.tooltipDismissed, undefined);
  }
  ui.window.events.pagehide();
});

test("notification view uses a labeled native select without help text or a tooltip", () => {
  assert.match(html, /<label for="show-notifications">Show notifications<\/label>\s*<select id="show-notifications" disabled>/);
  assert.match(html, /<option value="all" selected>All<\/option>\s*<option value="unread">Unread only<\/option>/);
  assert.doesNotMatch(html, /id="match-github-inbox|id="show-notifications-(?:tooltip|help)"/);
});

test("hiding empty tabs defaults on, saves only its preference, and preserves both choices on reopen", async t => {
  const storedSettings = { groupBy: "date", future: 42 };
  const ui = await renderer({ initialRows: [], storedSettings });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const toggle = ui.ids.get("hide-empty-tabs");
  assert.match(html, /id="hide-empty-tabs"[^>]*role="switch"[^>]*aria-checked="true" disabled/);
  assert.match(html, /<button id="hide-empty-tabs"[\s\S]*?<\/button>\s*<button id="auto-open"/);
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(toggle.disabled, false);
  assert.deepEqual(ui.ids.get("attention-tabs").children.filter(tab => !tab.hidden).map(tab => tab.textContent), ["All (0)"]);
  for (const hideEmptyTabs of [false, true]) {
    toggle.focus();
    toggle.events.click();
    assert.equal(toggle.disabled, true);
    await settle();
    assert.equal(ui.document.activeElement, toggle);
    assert.equal(toggle.getAttribute("aria-checked"), String(hideEmptyTabs));
    assert.deepEqual(storedSettings, { groupBy: "date", future: 42, hideEmptyTabs });
    const reopened = await renderer({ initialRows: [], storedSettings });
    t.after(() => { reopened.window.events.pagehide(); reopened.inbox.close(); });
    assert.equal(reopened.ids.get("hide-empty-tabs").getAttribute("aria-checked"), String(hideEmptyTabs));
    assert.equal(reopened.ids.get("attention-tabs").children.filter(tab => !tab.hidden).length, hideEmptyTabs ? 1 : 6);
  }
  assert.deepEqual(ui.calls.filter(call => call.path === "/api/settings" && call.options.method === "POST")
    .map(call => JSON.parse(call.options.body)), [{ hideEmptyTabs: false }, { hideEmptyTabs: true }]);
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("failed empty-tab setting saves retain the existing visibility and expose the error", async t => {
  const storedSettings = { hideEmptyTabs: false };
  const ui = await renderer({ initialRows: [], storedSettings, onSettings: input => {
    if (input) throw new Error("Synthetic settings failure");
  } });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const toggle = ui.ids.get("hide-empty-tabs");
  toggle.events.click();
  await settle();
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(toggle.disabled, false);
  assert.equal(storedSettings.hideEmptyTabs, false);
  assert.equal(ui.ids.get("attention-tabs").children.every(tab => !tab.hidden), true);
  assert.match(ui.ids.get("settings-error").textContent, /Synthetic settings failure/);
});

test("Settings fits the available viewport and moves above only when that provides more space", async t => {
  const ui = await renderer();
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const panel = ui.ids.get("settings-panel");
  const settings = ui.ids.get("settings");
  const toggle = ui.ids.get("settings-toggle");
  ui.window.innerHeight = 480;
  settings.open = true;
  settings.events.toggle();
  await settle();
  assert.equal(panel.dataset.placement, "below");
  assert.equal(panel.style.maxHeight, "251px");
  toggle.bounds = { top: 207, bottom: 245 };
  ui.resizeAttention();
  ui.fireAnimationFrame();
  assert.equal(panel.style.maxHeight, "219px");
  toggle.bounds = { top: 175, bottom: 213 };
  ui.window.innerHeight = 320;
  ui.window.events.resize();
  assert.equal(panel.dataset.placement, "above");
  assert.equal(panel.style.maxHeight, "159px");
  toggle.bounds = { top: 10, bottom: 48 };
  ui.window.events.scroll();
  assert.equal(panel.dataset.placement, "below");
  assert.equal(panel.style.maxHeight, "192px");
  toggle.bounds = { top: -50, bottom: -12 };
  ui.window.events.scroll();
  assert.equal(settings.open, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.dataset.tooltipDismissed, "true");
  settings.open = true;
  toggle.bounds = { top: 330, bottom: 368 };
  ui.window.events.resize();
  assert.equal(settings.open, false);
});

test("resize observations coalesce overflow and overlay writes into the next animation frame", async t => {
  const ui = await renderer();
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const panel = ui.ids.get("settings-panel");
  const previous = ui.ids.get("attention-previous");
  const next = ui.ids.get("attention-next");
  const navigation = ui.ids.get("attention-navigation");
  navigation.clientWidth = 300;
  Object.assign(ui.ids.get("attention-tabs"), { clientWidth: 236, scrollWidth: 600 });
  ui.ids.get("settings").open = true;
  ui.window.innerHeight = 480;
  const anchor = ui.ids.get("refresh-control");
  anchor.hovered = true;
  anchor.bounds = { top: 100 };
  ui.ids.get("refresh-tooltip").bounds = { height: 40 };
  for (let index = 0; index < 3; index++) ui.resizeAttention();
  assert.equal(previous.hidden, true);
  assert.equal(next.hidden, true);
  assert.equal(next.getAttribute("aria-disabled"), "true");
  assert.equal(panel.style.maxHeight, undefined);
  assert.equal(anchor.dataset.tooltipPlacement, undefined);
  assert.equal(ui.animationFrames.size, 1);
  ui.fireAnimationFrame();
  assert.equal(ui.animationFrames.size, 0);
  assert.equal(previous.hidden, false);
  assert.equal(next.hidden, false);
  assert.equal(next.getAttribute("aria-disabled"), "false");
  assert.equal(panel.style.maxHeight, "251px");
  assert.equal(anchor.dataset.tooltipPlacement, "above");
  ui.ids.get("settings-toggle").bounds = { top: 207, bottom: 245 };
  anchor.bounds = { top: 20 };
  navigation.clientWidth = 700;
  ui.resizeAttention();
  assert.equal(ui.animationFrames.size, 1);
  assert.equal(panel.style.maxHeight, "251px");
  assert.equal(next.hidden, false);
  ui.fireAnimationFrame();
  assert.equal(previous.hidden, true);
  assert.equal(next.hidden, true);
  assert.equal(panel.style.maxHeight, "219px");
  assert.equal(anchor.dataset.tooltipPlacement, "below");
});

test("pagehide cancels pending overlay frames and prevents observer rescheduling", async t => {
  const ui = await renderer();
  t.after(() => ui.inbox.close());
  ui.ids.get("settings").open = true;
  ui.resizeAttention();
  assert.equal(ui.animationFrames.size, 1);
  const pendingFrame = [...ui.animationFrames.values()][0];
  ui.window.events.pagehide();
  assert.equal(ui.animationFrames.size, 0);
  assert.equal(ui.attentionDisconnected, true);
  pendingFrame();
  ui.resizeAttention();
  ui.fireAnimationFrame();
  assert.equal(ui.animationFrames.size, 0);
  assert.equal(ui.ids.get("settings-panel").style.maxHeight, undefined);
});

test("Settings activation dismisses its tooltip without preventing pointer or keyboard toggles", async t => {
  const ui = await renderer();
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const toggle = ui.ids.get("settings-toggle");
  for (const open of [true, false]) {
    toggle.events.pointerenter();
    assert.equal(toggle.dataset.tooltipDismissed, undefined);
    toggle.events.click({ preventDefault: () => assert.fail("Preserve native details activation") });
    ui.ids.get("settings").open = open;
    ui.ids.get("settings").events.toggle();
    await settle();
    assert.equal(toggle.dataset.tooltipDismissed, "true");
    assert.equal(toggle.getAttribute("aria-expanded"), String(open));
    toggle.events.focus();
    assert.equal(toggle.dataset.tooltipDismissed, undefined);
  }
});

test("tooltips prefer above, flip near the top edge and follow viewport changes without undoing dismissal", async t => {
  const ui = await renderer();
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const anchor = ui.ids.get("refresh-control");
  const tooltip = ui.ids.get("refresh-tooltip");
  tooltip.bounds = { height: 40 };
  for (const [top, expected] of [[100, "above"], [48, "above"], [47, "below"], [200, "above"]]) {
    anchor.bounds = { top };
    ui.ids.get("force-refresh").events.pointerenter();
    assert.equal(anchor.dataset.tooltipPlacement, expected);
  }
  for (const event of ["scroll", "resize"]) {
    anchor.bounds = { top: 20 };
    anchor.hovered = true;
    ui.window.events[event]();
    assert.equal(anchor.dataset.tooltipPlacement, "below");
    assert.equal(anchor.dataset.tooltipDismissed, undefined);
    anchor.hovered = false;
    ui.ids.get("force-refresh").focus();
    ui.ids.get("force-refresh").events.focus();
    anchor.bounds = { top: 100 };
    ui.window.events[event]();
    assert.equal(anchor.dataset.tooltipPlacement, "above");
    ui.document.events.keydown({ key: "Escape" });
    anchor.bounds = { top: 20 };
    ui.window.events[event]();
    assert.equal(anchor.dataset.tooltipPlacement, "above");
    assert.equal(anchor.dataset.tooltipDismissed, "true");
    ui.ids.get("force-refresh").events.focus();
  }
  ui.window.events.pagehide();
  assert.equal(ui.window.events.scroll, undefined);
  assert.equal(ui.window.events.resize, undefined);
});

test("opening the inbox dismisses tooltips without cancelling navigation or making local requests", async () => {
  const ui = await renderer();
  const link = ui.ids.get("open-inbox");
  link.focus();
  link.events.focus();
  const calls = ui.calls.length;
  link.events.click({ preventDefault: () => assert.fail("The inbox link must keep its default navigation") });
  assert.equal(ui.document.documentElement.dataset.pointerHoverSuppressed, "true");
  assert.equal(ui.ids.get("inbox-control").dataset.tooltipDismissed, "true");
  assert.equal(ui.document.activeElement, link);
  await ui.fireTimer(15_000);
  assert.equal(ui.ids.get("inbox-control").dataset.tooltipDismissed, "true");
  assert.equal(ui.calls.length, calls);
  link.events.pointerenter();
  assert.equal(ui.ids.get("inbox-control").dataset.tooltipDismissed, undefined);
  ui.document.events.pointermove();
  link.events.auxclick({ button: 2 });
  assert.equal(ui.document.documentElement.dataset.pointerHoverSuppressed, undefined);
  link.events.auxclick({ button: 1, preventDefault: () => assert.fail("Middle-click must remain native") });
  assert.equal(ui.document.documentElement.dataset.pointerHoverSuppressed, "true");
  ui.window.events.pagehide();
});

test("canvas blur, hiding and closing dismiss every toolbar tooltip without moving focus", async () => {
  for (const action of ["blur", "hidden", "non-intersecting", "close"]) {
    const ui = await renderer();
    const controls = [["open-inbox", "inbox-control"], ["force-refresh", "refresh-control"], ["settings-toggle", "settings-toggle"]];
    for (const [control] of controls) ui.ids.get(control).events.pointerenter();
    const focus = ui.ids.get("force-refresh");
    focus.focus();
    if (action === "hidden") {
      ui.document.hidden = true;
      ui.document.events.visibilitychange();
    } else if (action === "non-intersecting") ui.intersect(false);
    else ui.window.events[action === "close" ? "pagehide" : "blur"]();
    for (const [, anchor] of controls) assert.equal(ui.ids.get(anchor).dataset.tooltipDismissed, "true", action);
    assert.equal(ui.document.activeElement, focus);
    if (action === "blur") {
      await ui.fireTimer(15_000);
      assert.equal(ui.ids.get("refresh-control").dataset.tooltipDismissed, "true");
    }
    ui.window.events.pagehide();
  }
});

test("Settings puts an Auto-open slider above sound, saves startup preference and closes accessibly", async () => {
  assert.match(html, /<button\b[^>]*id="auto-open"[^>]*class="switch-toggle"[^>]*role="switch"/);
  assert.match(html, /<span>Auto-open<\/span>\s*<span class="switch-track" aria-hidden="true"><span class="switch-thumb"><\/span><\/span>/);
  assert.ok(html.indexOf('id="auto-open"') < html.indexOf('id="desktop-sound"'));
  assert.doesNotMatch(html, /Open on new sessions:/);
  assert.doesNotMatch(script, /\$\("auto-open"\)\.textContent\s*=/);
  const ui = await renderer();
  const settings = ui.ids.get("settings");
  settings.open = true;
  settings.events.toggle();
  await settle();
  assert.equal(ui.ids.get("settings-toggle").attributes["aria-expanded"], "true");
  assert.equal(ui.ids.get("auto-open").disabled, false);
  assert.equal(ui.ids.get("auto-open").attributes["aria-checked"], "false");
  ui.ids.get("auto-open").events.click();
  await settle();
  assert.equal(ui.ids.get("auto-open").attributes["aria-checked"], "true");
  assert.equal(ui.ids.get("settings-status").textContent, "");
  ui.document.events.click({ target: ui.ids.get("desktop-sound") });
  assert.equal(settings.open, true);
  ui.document.events.click({ target: ui.ids.get("desktop-notifications").children[0] });
  assert.equal(settings.open, true);
  ui.document.events.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(settings.open, false);
  assert.equal(ui.document.activeElement, ui.ids.get("settings-toggle"));
  settings.open = true;
  settings.events.toggle();
  await settle();
  assert.equal(ui.ids.get("auto-open").attributes["aria-checked"], "true");
  ui.document.events.click({ target: ui.ids.get("search") });
  assert.equal(settings.open, false);
});

test("desktop controls persist independently, preserve focus and are disabled on unsupported hosts", async () => {
  const ui = await renderer();
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  const desktop = ui.ids.get("desktop-notifications");
  const sound = ui.ids.get("desktop-sound");
  assert.equal(desktop.disabled, false);
  assert.equal(desktop.attributes["aria-checked"], "false");
  assert.equal(sound.disabled, true);
  desktop.focus();
  desktop.events.click();
  await settle();
  assert.equal(desktop.attributes["aria-checked"], "true");
  assert.equal(ui.document.activeElement, desktop);
  assert.equal(sound.disabled, false);
  sound.focus();
  sound.value = "Ping";
  sound.events.change();
  await settle();
  assert.equal(sound.value, "Ping");
  assert.equal(ui.document.activeElement, sound);
  assert.equal(sound.children.some(option => option.value === "Submarine"), true);
  assert.equal(ui.ids.get("settings-status").textContent, "");
  desktop.events.click();
  await settle();
  assert.equal(sound.disabled, true);
  assert.equal(sound.value, "Ping");
  const unsupported = await renderer({ desktopPlatform: "freebsd" });
  unsupported.ids.get("settings").open = true;
  unsupported.ids.get("settings").events.toggle();
  await settle();
  assert.equal(unsupported.ids.get("desktop-notifications").disabled, true);
  assert.equal(unsupported.ids.get("desktop-sound").disabled, true);
  assert.match(unsupported.ids.get("desktop-status").textContent, /macOS, Windows and Linux/);
  assert.equal(unsupported.ids.get("desktop-status").hidden, false);
  assert.equal(unsupported.ids.get("auto-open").disabled, false);
});

test("Windows and Linux sound pickers use their own sound catalogs", async () => {
  for (const [platform, expected] of [["win32", "Mail"], ["linux", "message-new-email"]]) {
    const ui = await renderer({ desktopPlatform: platform });
    ui.ids.get("settings").open = true;
    ui.ids.get("settings").events.toggle();
    await settle();
    assert.equal(ui.ids.get("desktop-notifications").disabled, false);
    const values = ui.ids.get("desktop-sound").children.map(option => option.value);
    assert.ok(values.includes(expected));
    assert.ok(values.includes("none"));
    assert.equal(values.includes("Glass"), false);
  }
});

test("a saved sound unavailable on this platform remains selected until the user chooses a supported sound", async () => {
  const storedSettings = { desktopNotifications: true, desktopSound: "Ping" };
  const ui = await renderer({ desktopPlatform: "win32", storedSettings });
  const sound = ui.ids.get("desktop-sound");
  assert.equal(sound.value, "Ping");
  assert.equal(sound.disabled, false);
  assert.equal(sound.children.find(option => option.value === "Ping").textContent, "Unavailable on this platform: Ping");
  assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
  sound.value = "Mail";
  sound.events.change();
  await settle();
  assert.equal(storedSettings.desktopSound, "Mail");
  assert.equal(sound.value, "Mail");
  assert.equal(sound.children.some(option => option.value === "Ping"), false);
  assert.equal(ui.ids.get("settings-error").hidden, true);
  assert.deepEqual(ui.patches, []);
  ui.window.events.pagehide();
});

test("missing desktop sound capabilities preserve the saved value without enabling the picker", async () => {
  const ui = await renderer({ desktopStatus: { supported: false, sounds: undefined, message: "Desktop backend unavailable." },
    storedSettings: { desktopNotifications: true, desktopSound: "Ping" } });
  const sound = ui.ids.get("desktop-sound");
  assert.equal(sound.value, "Ping");
  assert.equal(sound.disabled, true);
  assert.deepEqual(sound.children.map(option => option.textContent), ["Unavailable on this platform: Ping"]);
  assert.equal(ui.ids.get("desktop-status").textContent, "Desktop backend unavailable.");
  assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
  ui.window.events.pagehide();
});

test("a settings edit during a background status read is queued rather than dropped", async () => {
  let reads = 0;
  let finish;
  const ui = await renderer({ onSettings: input => {
    if (!input && ++reads === 3) return new Promise(resolve => { finish = resolve; });
  } });
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  assert.equal(ui.ids.get("settings-status").hidden, true);
  await ui.fireTimer();
  const control = ui.ids.get("desktop-notifications");
  assert.equal(control.disabled, false);
  assert.equal(ui.ids.get("settings-status").hidden, true);
  control.focus();
  control.events.click();
  assert.equal(control.disabled, true);
  finish();
  await settle();
  assert.equal(control.attributes["aria-checked"], "true");
  assert.equal(ui.document.activeElement, control);
  assert.equal(ui.ids.get("settings-status").hidden, true);
});

test("queued settings edits survive hidden background reads and save once when shown", async () => {
  for (const aborted of [false, true]) {
    for (const visibilitySource of ["document", "intersection"]) {
      const storedSettings = { autoOpen: true, darkMode: true, desktopNotifications: true, desktopSound: "default" };
      let reads = 0;
      let finish;
      const ui = await renderer({ storedSettings, onSettings: input => {
        if (!input && ++reads === 3) return new Promise((resolve, reject) => {
          finish = () => aborted
            ? reject(Object.assign(new Error("Synthetic aborted request"), { name: "AbortError" }))
            : resolve();
        });
      } });
      const setVisible = visible => {
        if (visibilitySource === "intersection") ui.intersect(visible);
        else {
          ui.document.hidden = !visible;
          ui.document.events.visibilitychange();
        }
      };
      const writes = () => ui.calls.filter(call => call.path === "/api/settings" && call.options.body)
        .map(call => JSON.parse(call.options.body));
      try {
        ui.ids.get("settings").open = true;
        ui.ids.get("settings").events.toggle();
        await settle();
        await ui.fireTimer();
        const control = ui.ids.get("desktop-notifications");
        control.focus();
        control.events.click();
        assert.equal(runInContext("pendingSettings.input.desktopNotifications", ui.context), false);
        setVisible(false);
        const reading = ui.calls.filter(call => call.path === "/api/settings").at(-1);
        assert.equal(reading.options.signal.aborted, true);
        finish();
        await settle();
        assert.deepEqual(writes(), []);
        assert.equal(runInContext("pendingSettings?.input.desktopNotifications", ui.context), false);
        assert.equal(storedSettings.desktopNotifications, true);
        setVisible(true);
        await settle();
        assert.deepEqual(writes(), [{ desktopNotifications: false }]);
        assert.equal(storedSettings.desktopNotifications, false);
        assert.equal(control.attributes["aria-checked"], "false");
        assert.equal(runInContext("pendingSettings", ui.context), undefined);
        setVisible(false);
        setVisible(true);
        await settle();
        assert.equal(writes().length, 1);
      } finally {
        finish?.();
        ui.window.events.pagehide();
        ui.inbox.close();
      }
    }
  }
});

test("Settings omits explanatory copy and hides empty status messages", async () => {
  assert.doesNotMatch(html, /dark-mode-help|startup-help|desktop-help|desktop-sound-help|Optional chime|Saved for your user/);
  assert.doesNotMatch(script, /desktop-help|desktop-sound-help/);
  const ui = await renderer();
  assert.equal(ui.ids.get("settings-status").hidden, true);
  assert.equal(ui.ids.get("desktop-status").hidden, true);
  assert.equal(ui.ids.get("update-status").textContent, " - Up to date");
  assert.doesNotMatch(ui.ids.get("update-status").textContent, /Last checked|Check again after/);
});

test("routine desktop statuses stay hidden, but notification errors remain visible until recovery", async () => {
  for (const state of ["off", "starting", "watching", "shared"]) {
    const ui = await renderer({ desktopStatus: { state, message: `Routine ${state} status.` } });
    assert.equal(ui.ids.get("desktop-status").textContent, "");
    assert.equal(ui.ids.get("desktop-status").hidden, true);
  }
  const desktopStatus = { state: "error", message: "Check system notification permissions." };
  const ui = await renderer({ desktopStatus });
  assert.equal(ui.ids.get("desktop-status").textContent, desktopStatus.message);
  assert.equal(ui.ids.get("desktop-status").hidden, false);
  desktopStatus.state = "watching";
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  assert.equal(ui.ids.get("desktop-status").textContent, "");
  assert.equal(ui.ids.get("desktop-status").hidden, true);
});

test("settings failures are visible and do not claim a saved toggle", async () => {
  const ui = await renderer({ initialOffline: true });
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  assert.equal(ui.ids.get("auto-open").disabled, true);
  assert.equal(ui.ids.get("theme").disabled, true);
  assert.equal(ui.ids.get("group-by").disabled, true);
  assert.equal(ui.ids.get("settings-error").hidden, false);
  assert.equal(ui.ids.get("settings-status").hidden, false);
  assert.match(ui.ids.get("settings-status").textContent, /retry/);
  ui.setOffline(false);
  ui.ids.get("settings").events.toggle();
  await settle();
  assert.equal(ui.ids.get("auto-open").disabled, false);
  assert.equal(ui.ids.get("theme").disabled, false);
  assert.equal(ui.ids.get("group-by").disabled, false);
  assert.equal(ui.ids.get("settings-error").hidden, true);
  assert.equal(ui.ids.get("settings-status").hidden, true);
});

test("inbox settings warnings stay visible with Settings closed and clear after recovery", async t => {
  const ui = await renderer();
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const warning = { code: "settings_read", message: "Saved settings are unavailable." };
  await runInContext(`state.settingsError = ${JSON.stringify(warning)}; render()`, ui.context);
  assert.equal(Boolean(ui.ids.get("settings").open), false);
  assert.equal(ui.ids.get("settings-error").hidden, false);
  assert.equal(ui.ids.get("settings-error").textContent, warning.message);
  assert.equal(ui.ids.get("notice").hidden, true);
  assert.equal(ui.document.querySelectorAll("article").length, 1);
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("settings-error").hidden, true);
  await runInContext(`state.settingsError = ${JSON.stringify(warning)}; render()`, ui.context);
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  assert.equal(ui.ids.get("settings-error").hidden, true);
});

test("Group By is a labeled select above development settings and defaults to repo", async () => {
  assert.match(html, /<div class="select-setting">\s*<label for="group-by">Group By<\/label>\s*<select id="group-by" disabled>/);
  assert.match(html, /<option value="none">All notifications<\/option>\s*<option value="repo" selected>Repository<\/option>\s*<option value="date">Date<\/option>/);
  assert.match(html, /<select id="group-by"[^>]*>[\s\S]*?<\/select>\s*<\/div>\s*<section id="development-settings"/);
  const ui = await renderer();
  assert.equal(ui.ids.get("group-by").value, "repo");
  assert.equal(ui.ids.get("group-by").disabled, false);
  ui.ids.get("settings").open = true;
  ui.document.events.click({ target: ui.ids.get("group-by") });
  assert.equal(ui.ids.get("settings").open, true);
});

test("none restores cross-repository API order in one group with repository metadata", async () => {
  const ui = await renderer({ storedSettings: { groupBy: "none" }, initialRows: [
    thread("1", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-01T00:00:00Z" }),
    thread("4", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-03T00:00:00Z" }),
    thread("2", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-03T00:00:00Z" }),
    thread("3", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-02T00:00:00Z" }),
    thread("5", { unread: false, updated_at: "2026-01-04T00:00:00Z" }),
  ] });
  const list = ui.ids.get("groups");
  assert.equal(ui.ids.get("group-by").value, "none");
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].className, "repo-group");
  assert.equal(list.querySelectorAll("section").length, 1);
  assert.equal(list.querySelectorAll(".repo-name")[0].textContent, "All notifications");
  for (const action of ["read", "done"]) {
    assert.deepEqual(list.querySelectorAll("button").filter(node => node.dataset.action === action)
      .map(node => node.dataset.threadId), action === "read" ? ["1", "4", "2", "3"] : ["1", "4", "2", "3", "5"]);
  }
  assert.deepEqual(list.querySelectorAll("span").filter(node => node.className === "repository").map(node => node.textContent),
    ["example/alpha", "example/zulu", "example/zulu", "example/alpha", "example/widgets"]);
  assert.equal(ui.ids.get("collapse").hidden, false);
  assert.equal(list.attributes["aria-label"], "Notifications in GitHub order");
  const first = list.querySelectorAll("a")[0];
  first.focus();
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement, first);
  assert.equal(list.querySelectorAll("a")[0], first);
  assert.deepEqual(ui.patches, []);
});

test("date groups by local calendar day across repositories, newest first, with independent collapse state", async () => {
  const localDate = (month, day, hour) => new Date(2026, month - 1, day, hour).toISOString();
  const ui = await renderer({ storedSettings: { groupBy: "date" }, initialRows: [
    thread("1", { repository: { full_name: "example/zulu" }, updated_at: localDate(1, 31, 23) }),
    thread("2", { repository: { full_name: "example/alpha" }, updated_at: localDate(2, 1, 0) }),
    thread("3", { repository: { full_name: "example/zulu" }, updated_at: localDate(2, 1, 23) }),
    thread("4", { repository: { full_name: "example/alpha" }, updated_at: localDate(1, 31, 0) }),
    thread("5", { updated_at: new Date(2025, 11, 31, 12).toISOString() }),
  ] });
  const list = ui.ids.get("groups");
  const disclosures = () => list.querySelectorAll("button").filter(node => node.dataset.disclosure);
  assert.deepEqual(disclosures().map(node => node.dataset.focusKey), ["date:2026-2-1", "date:2026-1-31", "date:2025-12-31"]);
  assert.deepEqual(list.children.map(section => section.querySelectorAll("a").map(node => node.dataset.focusKey)),
    [["thread:2", "thread:3"], ["thread:1", "thread:4"], ["thread:5"]]);
  assert.equal(disclosures()[0].children[0].textContent,
    new Date(2026, 1, 1).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }));
  assert.equal(disclosures()[0].children[1].textContent, "2 total \u00b7 2 unread");
  assert.equal(list.querySelectorAll("button").some(node => node.dataset.repository), false);
  assert.equal(list.querySelectorAll("span").filter(node => node.className === "repository").length, 5);
  assert.equal(list.attributes["aria-label"], "Notifications by date");
  disclosures()[0].focus();
  disclosures()[0].events.click();
  assert.equal(list.children[0].children[1].hidden, true);
  await runInContext("update()", ui.context);
  assert.equal(ui.document.activeElement, disclosures()[0]);
  assert.equal(list.children[0].children[1].hidden, true);
  ui.ids.get("collapse").events.click();
  assert.ok(disclosures().every(node => node.attributes["aria-expanded"] === "false"));
  assert.equal(ui.ids.get("collapse").textContent, "Expand all");
  ui.ids.get("collapse").events.click();
  assert.ok(disclosures().every(node => node.attributes["aria-expanded"] === "true"));
  assert.equal(ui.ids.get("collapse").textContent, "Collapse all");
});

test("grouping changes apply immediately, persist across panels and restore repository batch actions", async () => {
  const storedSettings = { autoOpen: true, darkMode: false };
  const ui = await renderer({ storedSettings, initialRows: [
    thread("1", { repository: { full_name: "example/zulu" } }),
    thread("2", { repository: { full_name: "example/alpha" } }),
    thread("3", { repository: { full_name: "example/zulu" } }),
    thread("4", { repository: { full_name: "example/alpha" } }),
  ] });
  const select = ui.ids.get("group-by");
  const list = ui.ids.get("groups");
  list.querySelectorAll("button").find(node => node.dataset.focusKey === "repo:example/alpha").events.click();
  for (const groupBy of ["none", "date", "repo"]) {
    select.focus();
    select.value = groupBy;
    select.events.change();
    assert.equal(select.disabled, true);
    await settle();
    assert.equal(select.disabled, false);
    assert.equal(ui.document.activeElement, select);
    assert.deepEqual(storedSettings, { autoOpen: true, darkMode: false, groupBy });
    const reopened = await renderer({ storedSettings });
    assert.equal(reopened.ids.get("group-by").value, groupBy);
    assert.equal(reopened.ids.get("collapse").hidden, false);
    reopened.window.events.pagehide();
  }
  assert.deepEqual(list.querySelectorAll("button").filter(node => node.dataset.batchAction === "read").map(node => node.dataset.repository),
    ["example/zulu", "example/alpha"]);
  assert.equal(list.querySelectorAll("button").find(node => node.dataset.focusKey === "repo:example/alpha").attributes["aria-expanded"], "false");
  const posts = ui.calls.filter(call => call.path === "/api/settings" && call.options.body);
  assert.deepEqual(posts.map(call => JSON.parse(call.options.body)), [{ groupBy: "none" }, { groupBy: "date" }, { groupBy: "repo" }]);
  assert.equal(ui.githubCalls.length, 1);
  assert.deepEqual(ui.patches, []);
});

test("failed grouping saves retain the prior list, restore the select and report a retryable error", async () => {
  let fail = true;
  const storedSettings = { groupBy: "repo" };
  const ui = await renderer({ storedSettings, onSettings: input => {
    if (input && fail) throw new Error("Could not save notification settings.");
  } });
  const select = ui.ids.get("group-by");
  const previous = ui.ids.get("groups").children[0];
  select.focus();
  select.value = "none";
  select.events.change();
  await settle();
  assert.equal(select.value, "repo");
  assert.equal(select.disabled, false);
  assert.equal(ui.document.activeElement, select);
  assert.equal(ui.ids.get("groups").children[0], previous);
  assert.equal(storedSettings.groupBy, "repo");
  assert.equal(ui.ids.get("settings-error").hidden, false);
  assert.match(ui.ids.get("settings-status").textContent, /Could not save.*retry/);
  fail = false;
  select.value = "none";
  select.events.change();
  await settle();
  assert.equal(select.value, "none");
  assert.equal(ui.ids.get("collapse").hidden, false);
  assert.equal(ui.ids.get("settings-error").hidden, true);
});

test("a pending grouping save blocks duplicates and does not steal newly moved focus", async () => {
  let release;
  const ui = await renderer({ onSettings: input =>
    input ? new Promise(resolve => { release = resolve; }) : undefined });
  const select = ui.ids.get("group-by");
  const previous = ui.ids.get("groups").children[0];
  select.focus();
  select.value = "none";
  select.events.change();
  select.events.change();
  assert.equal(ui.calls.filter(call => call.path === "/api/settings" && call.options.body).length, 1);
  assert.equal(ui.ids.get("groups").children[0], previous);
  ui.ids.get("search").focus();
  release();
  await settle();
  assert.equal(ui.ids.get("groups").querySelectorAll(".repo-name")[0].textContent, "All notifications");
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
});

test("a grouping change during a background settings read is queued without changing desktop preferences", async () => {
  let reads = 0;
  let finish;
  const storedSettings = { groupBy: "repo", desktopNotifications: true, desktopSound: "Ping" };
  const ui = await renderer({ storedSettings, onSettings: input => {
    if (!input && ++reads === 3) return new Promise(resolve => { finish = resolve; });
  } });
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  await ui.fireTimer();
  const select = ui.ids.get("group-by");
  assert.equal(select.disabled, false);
  select.focus();
  select.value = "none";
  select.events.change();
  assert.equal(select.disabled, true);
  assert.equal(ui.ids.get("groups").children[0].className, "repo-group");
  finish();
  await settle();
  assert.equal(ui.document.activeElement, select);
  assert.equal(select.value, "none");
  assert.equal(ui.ids.get("groups").querySelectorAll(".repo-name")[0].textContent, "All notifications");
  assert.deepEqual(storedSettings, { groupBy: "none", desktopNotifications: true, desktopSound: "Ping" });
  assert.deepEqual(ui.calls.filter(call => call.path === "/api/settings" && call.options.body)
    .map(call => JSON.parse(call.options.body)), [{ groupBy: "none" }]);
});

test("grouping refreshes when a panel becomes visible and empty copy matches the saved mode", async () => {
  const storedSettings = { groupBy: "repo" };
  const ui = await renderer({ storedSettings, initialRows: [] });
  for (const groupBy of ["none", "date", "repo"]) {
    ui.intersect(false);
    storedSettings.groupBy = groupBy;
    ui.intersect(true);
    await settle();
    assert.equal(ui.ids.get("group-by").value, groupBy);
    assert.equal(ui.ids.get("groups").children.length, 0);
    assert.equal(ui.ids.get("collapse").hidden, true);
    assert.equal(ui.ids.get("empty").hidden, false);
    assert.equal(ui.ids.get("empty-description").textContent, groupBy === "none" ?
      "New notifications will appear here in GitHub inbox order." :
      `New notifications will appear here, grouped by ${groupBy === "repo" ? "repository" : "date"}.`);
  }
});

test("none and date regroup loaded read and unread results without including unloaded items", async () => {
  for (const groupBy of ["none", "date"]) {
    const ui = await renderer({ storedSettings: { groupBy }, onFetch: args => args.at(-1).includes("page=2") ?
      http([
        thread("3", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-03T12:00:00Z" }),
        thread("4", { unread: false }),
      ]) : http([
        thread("1", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-01T12:00:00Z" }),
        thread("2", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-02T12:00:00Z" }),
      ], { link: next }) });
    const order = () => ui.ids.get("groups").querySelectorAll("a").map(node => node.dataset.focusKey);
    assert.deepEqual(order(), groupBy === "none" ? ["thread:1", "thread:2"] : ["thread:2", "thread:1"]);
    await ui.ids.get("more").events.click();
    assert.deepEqual(order(), groupBy === "none" ? ["thread:1", "thread:2", "thread:3", "thread:4"] : ["thread:4", "thread:3", "thread:2", "thread:1"]);
    assert.equal(ui.ids.get("count").textContent, "4 total \u00b7 3 unread");
    await runInContext('update("filters", { query: "alpha" })', ui.context);
    assert.deepEqual(order(), groupBy === "none" ? ["thread:1", "thread:3"] : ["thread:3", "thread:1"]);
    assert.match(ui.ids.get("count").textContent, /3 unread.*2 matching/);
    await runInContext('update("filters", { query: "no match" })', ui.context);
    assert.deepEqual(order(), []);
    assert.equal(ui.ids.get("collapse").hidden, true);
    assert.equal(ui.ids.get("empty-title").textContent, "No matches in loaded notifications");
    await runInContext('update("filters", { query: "" })', ui.context);
    assert.deepEqual(order(), groupBy === "none" ? ["thread:1", "thread:2", "thread:3", "thread:4"] : ["thread:4", "thread:3", "thread:2", "thread:1"]);
    assert.equal(ui.githubCalls.length, 2);
    ui.window.events.pagehide();
  }
});

test("row reads in none and date modes retain rows and focus their Done action", async () => {
  for (const groupBy of ["none", "date"]) {
    const ui = await renderer({ storedSettings: { groupBy }, initialRows: [
      thread("1", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-01T12:00:00Z" }),
      thread("2", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-03T12:00:00Z" }),
      thread("3", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-02T12:00:00Z" }),
    ] });
    const readButtons = () => ui.ids.get("groups").querySelectorAll("button").filter(node => node.dataset.action === "read");
    const ids = groupBy === "none" ? ["1", "2", "3"] : ["2", "3", "1"];
    const first = readButtons()[0];
    first.focus();
    await first.events.click();
    assert.deepEqual(ui.patches, [`/notifications/threads/${ids[0]}`]);
    assert.deepEqual(readButtons().map(node => node.dataset.threadId), ids.slice(1));
    assert.equal(ui.document.activeElement.dataset.focusKey, `done:${ids[0]}`);
    const last = readButtons().find(node => node.dataset.threadId === ids[2]);
    last.focus();
    await last.events.click();
    assert.equal(ui.document.activeElement.dataset.focusKey, `done:${ids[2]}`);
    readButtons()[0].focus();
    await readButtons()[0].events.click();
    assert.equal(ui.document.activeElement.dataset.focusKey, `done:${ids[1]}`);
    assert.equal(ui.ids.get("empty").hidden, true);
    assert.equal(readButtons().length, 0);
    ui.window.events.pagehide();
  }
});

test("Theme offers Match Copilot, Dark and Light while preserving saved values", async () => {
  assert.match(html, /<div class="select-setting">\s*<label for="theme">Theme<\/label>\s*<select id="theme" disabled>/);
  assert.match(html, /<option value="system" selected>Match Copilot<\/option>\s*<option value="dark">Dark<\/option>\s*<option value="light">Light<\/option>/);
  assert.match(html, /<select id="theme"[^>]*>[\s\S]*?<\/select>\s*<\/div>\s*<div class="select-setting">\s*<label for="group-by">/);
  assert.doesNotMatch(html, /id="dark-mode"/);
  for (const [darkMode, theme] of [[undefined, "system"], [null, "system"], [true, "dark"], [false, "light"]]) {
    const storedSettings = darkMode === undefined ? {} : { darkMode };
    const ui = await renderer({ storedSettings });
    assert.equal(ui.ids.get("theme").disabled, false);
    assert.equal(ui.ids.get("theme").value, theme);
    assert.equal(ui.document.documentElement.dataset.notificationTheme, theme === "system" ? undefined : theme);
    assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
    ui.ids.get("settings").open = true;
    ui.document.events.click({ target: ui.ids.get("theme") });
    assert.equal(ui.ids.get("settings").open, true);
    ui.window.events.pagehide();
  }
});

test("Match Copilot follows the app theme and falls back to OS changes only when no app theme is provided", async () => {
  const ui = await renderer({ appColorMode: "dark", systemDark: false });
  assert.equal(ui.ids.get("theme").value, "system");
  assert.equal(ui.document.documentElement.dataset.notificationTheme, undefined);
  ui.setSystemTheme(true);
  assert.equal(ui.document.documentElement.dataset.notificationTheme, undefined);
  ui.setAppTheme("light");
  assert.equal(ui.document.documentElement.dataset.notificationTheme, undefined);
  ui.setAppTheme(null);
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
  ui.setSystemTheme(false);
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "light");
  ui.document.body.setAttribute("data-color-mode", "light");
  ui.setSystemTheme(true);
  assert.equal(ui.document.documentElement.dataset.notificationTheme, undefined);
  assert.equal(ui.ids.get("theme").value, "system");
  assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
  ui.window.events.pagehide();
});

test("custom app theme tones retain host colors and explicit overrides still win", async t => {
  for (const target of ["documentElement", "body"]) {
    const ui = await renderer({ appColorMode: null, systemDark: false });
    t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
    const host = ui.document[target];
    for (const tone of ["dark", "light"]) {
      host.setAttribute("data-theme-tone", tone);
      ui.setSystemTheme(tone !== "dark");
      assert.equal(ui.document.documentElement.dataset.notificationTheme, undefined);
      const theme = ui.ids.get("theme");
      theme.value = "dark";
      theme.events.change();
      await settle();
      assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
      theme.value = "system";
      theme.events.change();
      await settle();
      assert.equal(ui.document.documentElement.dataset.notificationTheme, undefined);
    }
    host.removeAttribute("data-theme-tone");
    ui.setSystemTheme(true);
    assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
    host.setAttribute("data-theme-tone", "auto");
    host.setAttribute("data-color-mode", "light");
    ui.setSystemTheme(true);
    assert.equal(ui.document.documentElement.dataset.notificationTheme, undefined);
  }
});

test("Dark, Light and Match Copilot choices persist across panels without changing other preferences", async () => {
  const storedSettings = { autoOpen: true, darkMode: null, groupBy: "date", desktopNotifications: true, desktopSound: "Ping" };
  const ui = await renderer({ storedSettings });
  const select = ui.ids.get("theme");
  for (const [theme, darkMode] of [["dark", true], ["light", false], ["system", null]]) {
    select.focus();
    select.value = theme;
    select.events.change();
    assert.equal(select.disabled, true);
    await settle();
    assert.equal(select.value, theme);
    assert.equal(select.disabled, false);
    assert.equal(ui.document.activeElement, select);
    assert.deepEqual(storedSettings, { autoOpen: true, darkMode, groupBy: "date", desktopNotifications: true, desktopSound: "Ping" });
    assert.equal(ui.ids.get("settings-status").hidden, true);
    for (const mode of ["dark", "light"]) {
      ui.setAppTheme(mode);
      ui.setSystemTheme(mode === "dark");
      assert.equal(select.value, theme);
      assert.equal(ui.document.documentElement.dataset.notificationTheme, theme === "system" ? undefined : theme);
    }
    const reopened = await renderer({ storedSettings, appColorMode: "dark", systemDark: true });
    assert.equal(reopened.ids.get("theme").value, theme);
    assert.equal(reopened.document.documentElement.dataset.notificationTheme, theme === "system" ? undefined : theme);
    reopened.window.events.pagehide();
  }
  assert.deepEqual(ui.calls.filter(call => call.path === "/api/settings" && call.options.body)
    .map(call => JSON.parse(call.options.body)), [{ darkMode: true }, { darkMode: false }, { darkMode: null }]);
  assert.equal(ui.patches.length, 0);
  ui.window.events.pagehide();
});

test("failed Theme saves restore the selected choice and focus with an explicit retryable error", async () => {
  const storedSettings = { autoOpen: false, darkMode: true };
  let fail = true;
  const ui = await renderer({ storedSettings, onSettings: input => {
    if (input && fail) throw new Error("Could not save notification settings.");
  } });
  const select = ui.ids.get("theme");
  select.focus();
  select.value = "system";
  select.events.change();
  await settle();
  assert.equal(select.disabled, false);
  assert.equal(select.value, "dark");
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
  assert.equal(storedSettings.darkMode, true);
  assert.equal(ui.document.activeElement, select);
  assert.match(ui.ids.get("settings-status").textContent, /Could not save.*retry/);
  assert.doesNotMatch(ui.ids.get("settings-status").textContent, /Saved\./);
  assert.equal(ui.ids.get("settings-error").hidden, false);
  fail = false;
  select.value = "system";
  select.events.change();
  await settle();
  assert.equal(storedSettings.darkMode, null);
  assert.equal(select.value, "system");
  assert.equal(ui.document.documentElement.dataset.notificationTheme, undefined);
  assert.equal(ui.ids.get("settings-error").hidden, true);
});

test("settings saves keep status text hidden for toggles and dropdowns", async () => {
  for (const [id, event, value] of [
    ["auto-open", "click"],
    ["theme", "change", "dark"],
    ["desktop-notifications", "click"],
    ["desktop-sound", "change", "Ping"],
    ["group-by", "change", "none"],
  ]) {
    let finish;
    const ui = await renderer({
      storedSettings: { autoOpen: false, darkMode: false, desktopNotifications: true, desktopSound: "default", groupBy: "repo" },
      onSettings: input => input ? new Promise(resolve => { finish = resolve; }) : undefined,
    });
    const control = ui.ids.get(id);
    if (value !== undefined) control.value = value;
    control.events[event]();
    assert.equal(control.disabled, true);
    assert.equal(ui.ids.get("settings-status").textContent, "");
    assert.equal(ui.ids.get("settings-status").hidden, true);
    finish();
    await settle();
    assert.equal(ui.ids.get("settings-status").textContent, "");
    assert.equal(ui.ids.get("settings-status").hidden, true);
    assert.equal(ui.ids.get("settings-error").hidden, true);
    ui.window.events.pagehide();
  }
});

test("a pending theme save blocks duplicate changes without stealing focus", async () => {
  let release;
  const storedSettings = { autoOpen: false, darkMode: false };
  const ui = await renderer({ storedSettings, onSettings: input =>
    input ? new Promise(resolve => { release = resolve; }) : undefined });
  const select = ui.ids.get("theme");
  select.focus();
  select.value = "dark";
  select.events.change();
  select.events.change();
  assert.equal(ui.calls.filter(call => call.path === "/api/settings" && call.options.body).length, 1);
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "light");
  ui.ids.get("search").focus();
  release();
  await settle();
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
  assert.equal(ui.document.activeElement, ui.ids.get("search"));
});

test("a Theme change during a background settings read is queued and saved once", async () => {
  let reads = 0;
  let finish;
  const storedSettings = { darkMode: true };
  const ui = await renderer({ storedSettings, onSettings: input => {
    if (!input && ++reads === 3) return new Promise(resolve => { finish = resolve; });
  } });
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  await ui.fireTimer();
  const select = ui.ids.get("theme");
  select.focus();
  select.value = "system";
  select.events.change();
  assert.equal(select.disabled, true);
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
  finish();
  await settle();
  assert.equal(select.value, "system");
  assert.equal(ui.document.documentElement.dataset.notificationTheme, undefined);
  assert.equal(ui.document.activeElement, select);
  assert.equal(storedSettings.darkMode, null);
  assert.deepEqual(ui.calls.filter(call => call.path === "/api/settings" && call.options.body)
    .map(call => JSON.parse(call.options.body)), [{ darkMode: null }]);
  ui.window.events.pagehide();
});

test("settings refresh on visibility and theme observers are cleaned up on close", async () => {
  const storedSettings = { autoOpen: false, darkMode: false };
  const ui = await renderer({ storedSettings });
  ui.intersect(false);
  storedSettings.darkMode = true;
  ui.intersect(true);
  await settle();
  assert.equal(ui.document.documentElement.dataset.notificationTheme, "dark");
  assert.equal(ui.ids.get("theme").value, "dark");
  ui.window.events.pagehide();
  assert.equal(ui.themeDisconnected, true);
  assert.equal(ui.media.events.change, undefined);
});
