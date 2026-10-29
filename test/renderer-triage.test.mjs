import test from "node:test";
import assert from "node:assert/strict";
import { renderer, settle, html } from "./renderer-fixtures.mjs";
import { syntheticTriage } from "./triage-fixtures.mjs";

test("Copilot sits beside the inbox and requires disclosure before any AI request", async () => {
  assert.ok(html.indexOf('id="open-inbox"') < html.indexOf('id="copilot-triage"'));
  assert.ok(html.indexOf('id="copilot-triage"') < html.indexOf('id="force-refresh"'));
  const f = await renderer();
  const button = f.ids.get("copilot-triage");
  assert.equal(button.disabled, false);
  await button.events.click();
  assert.equal(f.ids.get("triage-panel").hidden, false);
  assert.equal(f.ids.get("triage-disclosure").hidden, false);
  assert.match(f.ids.get("triage-status").textContent, /1 shown, loaded/);
  assert.equal(f.calls.some(call => call.path.includes("/triage/")), false);
  await f.ids.get("triage-dismiss").events.click();
  assert.equal(f.ids.get("triage-panel").hidden, true);
  assert.equal(f.document.activeElement, button);
  assert.equal(f.calls.some(call => call.path.includes("/triage/")), false);
});

test("validated recommendations render as text, preserve notifications and can be dismissed", async () => {
  const f = await renderer();
  await f.ids.get("copilot-triage").events.click();
  await f.ids.get("triage-start").events.click();
  await f.triage.done;
  await f.fireTimer();
  const recommendations = f.ids.get("groups").querySelectorAll(".triage-recommendation");
  assert.equal(recommendations.length, 1);
  assert.match(recommendations[0].querySelectorAll("p")[0].textContent, /<img/);
  assert.equal(recommendations[0].querySelectorAll("img").length, 0);
  assert.equal(f.ids.get("triage-disclosure").hidden, true);
  assert.match(f.ids.get("triage-status").textContent, /Suggestions appear/);
  assert.deepEqual([...f.patches, ...f.deletions], []);
  await f.ids.get("triage-dismiss").events.click();
  assert.equal(f.ids.get("groups").querySelectorAll(".triage-recommendation").length, 0);
});

test("filter changes invalidate a disclosure without automatically granting the new scope", async () => {
  const f = await renderer();
  await f.ids.get("copilot-triage").events.click();
  await f.inbox.setFilters({ query: "absent" });
  await f.fireTimer();
  assert.equal(f.ids.get("triage-start").disabled, true);
  assert.match(f.ids.get("triage-status").textContent, /selection changed/);
  await f.ids.get("triage-start").events.click();
  assert.equal(f.calls.some(call => call.path.includes("/triage/")), false);
});

test("cancellation, interrupted requests and provider failures are visible without writes", async () => {
  const f = await renderer({ triageRun: options => new Promise((resolve, reject) =>
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })) });
  await f.ids.get("copilot-triage").events.click();
  await f.ids.get("triage-start").events.click();
  assert.equal(f.ids.get("triage-cancel").hidden, false);
  await f.ids.get("triage-cancel").events.click();
  await f.triage.done;
  await f.fireTimer();
  assert.match(f.ids.get("triage-status").textContent, /cancelled/);

  const failed = await renderer({ triageRun: async () => { throw new Error("private"); } });
  await failed.ids.get("copilot-triage").events.click();
  await failed.ids.get("triage-start").events.click();
  await failed.triage.done;
  await failed.fireTimer();
  assert.match(failed.ids.get("triage-error").textContent, /triage failed/);
  assert.doesNotMatch(failed.ids.get("triage-error").textContent, /private/);

  const offline = await renderer();
  await offline.ids.get("copilot-triage").events.click();
  offline.setOffline(true);
  await offline.ids.get("triage-start").events.click();
  assert.match(offline.ids.get("triage-error").textContent, /connection failure/);
  assert.deepEqual([...f.patches, ...f.deletions], []);
});

test("hidden panels do not start triage; changed notification content clears old advice", async () => {
  const f = await renderer();
  f.document.hidden = true;
  await f.ids.get("copilot-triage").events.click();
  await f.ids.get("triage-start").events.click();
  assert.equal(f.calls.some(call => call.path.includes("/triage/")), false);
  f.document.hidden = false;
  await f.ids.get("copilot-triage").events.click();
  await f.ids.get("triage-start").events.click();
  await f.triage.done;
  f.inbox.pages[0].items[0].title = "Changed";
  await f.fireTimer();
  assert.match(f.ids.get("triage-status").textContent, /Shown notifications changed/);
  assert.equal(f.ids.get("groups").querySelectorAll(".triage-recommendation").length, 0);
  await settle();
});

test("thread-backed evidence is labeled without rendering untrusted HTML", async () => {
  const f = await renderer({ triageRun: async options => {
    const result = await syntheticTriage(options);
    f.inbox.client.triageContext = async () => ({ available: true });
    await options.tools[1].handler({ ref: "n1" });
    return result;
  } });
  await f.ids.get("copilot-triage").events.click();
  await f.ids.get("triage-start").events.click();
  await f.triage.done;
  await f.fireTimer(1000);
  assert.match(f.ids.get("groups").querySelectorAll(".triage-recommendation")[0].querySelectorAll("p")[1].textContent,
    /bounded thread context/);
});

test("triage requests serialize local state changes and retain a queued refresh", async () => {
  let finish;
  const f = await renderer({ onTriage: () => new Promise(resolve => { finish = resolve; }) });
  await f.ids.get("copilot-triage").events.click();
  const starting = f.ids.get("triage-start").events.click();
  await settle();
  const before = f.calls.length;
  await f.fireTimer();
  await f.ids.get("force-refresh").events.click();
  assert.equal(f.calls.length, before, "No poll or refresh can race with a triage response");
  assert.equal(f.ids.get("groups").querySelectorAll(".mark-read")[0].disabled, true);
  finish();
  await starting;
  await settle();
  assert.equal(f.calls.filter(call => call.path === "/api/refresh").length, 2);
  await f.triage.done;
  assert.equal(f.triage.snapshot().status, "complete");
  assert.deepEqual(f.patches, []);
});

test("subsequent clicks and new panels start directly using only the saved acknowledgment", async () => {
  const storedSettings = { autoOpen: false, darkMode: null, triageConsentVersion: 0 };
  const f = await renderer({ storedSettings });
  await f.ids.get("copilot-triage").events.click();
  assert.equal(f.ids.get("triage-disclosure").hidden, false);
  await f.ids.get("triage-start").events.click();
  await f.triage.done;
  assert.equal(storedSettings.triageConsentVersion, 1);
  const other = await renderer({ storedSettings });
  await other.ids.get("copilot-triage").events.click();
  await other.triage.done;
  assert.equal(other.ids.get("triage-disclosure").hidden, true);
  const request = other.calls.find(call => call.path === "/api/triage/start");
  assert.deepEqual(JSON.parse(request.options.body), { selectionKey: other.inbox.shownSelection().selectionKey });
  assert.deepEqual([...f.patches, ...other.patches], []);
});

test("the remembered warning can be reset and remains available under Settings", async () => {
  const storedSettings = { triageConsentVersion: 1, desktopNotifications: false, desktopSound: "default" };
  const f = await renderer({ storedSettings });
  assert.equal(f.ids.get("reset-triage-consent").disabled, false);
  assert.match(f.ids.get("triage-consent-status").textContent, /starts triage directly/);
  await f.ids.get("reset-triage-consent").events.click();
  assert.equal(storedSettings.triageConsentVersion, 0);
  assert.equal(f.ids.get("reset-triage-consent").disabled, true);
  await f.ids.get("copilot-triage").events.click();
  assert.equal(f.ids.get("triage-disclosure").hidden, false);
  assert.equal(f.calls.some(call => call.path === "/api/triage/start"), false);
});

test("Copilot clicks reread acknowledgment changes from other panels before starting", async () => {
  for (const [before, after] of [[1, 0], [0, 1], [1, 2]]) {
    const storedSettings = { triageConsentVersion: before };
    const f = await renderer({ storedSettings });
    storedSettings.triageConsentVersion = after;
    await f.ids.get("copilot-triage").events.click();
    await f.triage.done;
    assert.equal(f.calls.some(call => call.path === "/api/triage/start"), after === 1);
    assert.equal(f.ids.get("triage-disclosure").hidden, after === 1);
  }
});

test("failed acknowledgment checks do not start AI, and reset failures preserve the saved choice", async () => {
  let fail = false;
  const storedSettings = { triageConsentVersion: 1 };
  const f = await renderer({ storedSettings, onSettings: async () => {
    if (fail) throw new Error("Settings unavailable.");
  } });
  fail = true;
  await f.ids.get("copilot-triage").events.click();
  assert.match(f.ids.get("triage-error").textContent, /Settings unavailable/);
  assert.equal(f.calls.some(call => call.path === "/api/triage/start"), false);
  await f.ids.get("reset-triage-consent").events.click();
  assert.equal(storedSettings.triageConsentVersion, 1);
  assert.match(f.ids.get("settings-error").textContent, /Settings unavailable/);
});

test("a reset racing with a direct start returns to the disclosure without running AI", async () => {
  const storedSettings = { triageConsentVersion: 1 };
  const f = await renderer({ storedSettings, onTriage: async () => { storedSettings.triageConsentVersion = 0; } });
  await f.ids.get("copilot-triage").events.click();
  assert.equal(f.triage.snapshot().status, "idle");
  assert.equal(f.ids.get("triage-disclosure").hidden, false);
  assert.match(f.ids.get("triage-error").textContent, /confirm.*disclosure/);
  assert.equal(f.ids.get("reset-triage-consent").disabled, true);
});

test("clicking Copilot again after completion starts a fresh run without dismissing the old result", async () => {
  const f = await renderer({ storedSettings: { triageConsentVersion: 1 } });
  await f.ids.get("copilot-triage").events.click();
  await f.triage.done;
  await f.fireTimer();
  const first = f.triage.snapshot().token;
  await f.ids.get("copilot-triage").events.click();
  await f.triage.done;
  assert.notEqual(f.triage.snapshot().token, first);
  assert.equal(f.ids.get("triage-disclosure").hidden, true);
  assert.equal(f.calls.filter(call => call.path === "/api/triage/start").length, 2);
});
