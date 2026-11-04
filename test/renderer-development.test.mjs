import test from "node:test";
import assert from "node:assert/strict";
import { html, renderer, settle } from "./renderer-fixtures.mjs";
import { http } from "./fixtures.mjs";

const baseUrl = "https://git.example.com/api/v3";
const defaultBase = "https://api.github.com";

test("development API help explains how to reload through the command palette", () => {
  assert.match(html, /id="development-api-help"[^>]*>[^<]*Reload extension after saving with ⌘\+k -> refresh canvas\./);
  assert.match(html, /refresh canvas\.<\/p>\s*<p id="development-api-auth" class="settings-help">Authenticate the selected host/);
  assert.match(html, /id="development-api-url"[^>]*aria-describedby="development-api-help development-api-auth"/);
});

test("API controls stay hidden without the source-only capability", async () => {
  const ui = await renderer();
  assert.equal(ui.ids.get("development-settings").hidden, true);
  assert.equal(ui.ids.get("development-api-notice").hidden, true);
  ui.ids.get("development-api-save").events.click();
  assert.equal(ui.calls.some(call => call.path === "/api/development"), false);
  ui.window.events.pagehide();
});

for (const settingsFailed of [false, true]) {
  test(`initial inbox links wait for the active API when settings ${settingsFailed ? "fail" : "load"}`, async t => {
    const activeBaseUrl = "https://git.example.com:8443/api/v3";
    const developmentApi = { baseUrl: activeBaseUrl, savedBaseUrl: defaultBase, requiresReload: true };
    let finishSettings;
    let finishRefresh;
    const ui = await renderer({
      developmentApi,
      onSettings: () => new Promise((resolve, reject) => {
        finishSettings = () => settingsFailed ? reject(new Error("Synthetic settings failure")) : resolve();
      }),
      onFetch: async () => {
        await new Promise(resolve => { finishRefresh = resolve; });
        return http([]);
      },
    });
    t.after(() => {
      finishSettings?.();
      finishRefresh?.();
      ui.window.events.pagehide();
    });
    const link = ui.ids.get("open-inbox");
    assert.equal(link.href, "");
    assert.equal(link.getAttribute("aria-disabled"), "true");
    assert.equal(link.tabIndex, -1);
    assert.equal(ui.ids.get("development-api-notice").hidden, true);
    finishSettings();
    await settle();
    assert.equal(ui.inbox.busy, true);
    assert.equal(link.getAttribute("aria-disabled"), String(settingsFailed));
    if (settingsFailed) {
      assert.equal(link.href, "");
      assert.equal(ui.ids.get("development-api-notice").hidden, true);
    } else {
      assert.equal(link.href, "https://git.example.com:8443/notifications");
      assert.equal(ui.ids.get("development-api-notice").hidden, false);
      assert.match(ui.ids.get("development-api-notice").textContent, /https:\/\/git\.example\.com:8443\/api\/v3/);
    }
    finishRefresh();
    await settle();
    assert.equal(link.href, "https://git.example.com:8443/notifications");
    assert.equal(link.getAttribute("aria-disabled"), "false");
    assert.equal(link.tabIndex, 0);
    assert.equal(ui.ids.get("development-api-notice").hidden, false);
  });
}

test("source settings save a custom URL without changing the active API, then allow reverting the selection", async () => {
  const developmentApi = { baseUrl: defaultBase, savedBaseUrl: defaultBase, requiresReload: false };
  const ui = await renderer({ developmentApi });
  const selector = ui.ids.get("development-api");
  const input = ui.ids.get("development-api-url");
  const save = ui.ids.get("development-api-save");
  assert.equal(ui.ids.get("development-settings").hidden, false);
  assert.equal(selector.value, "github");
  assert.equal(input.disabled, true);
  selector.value = "custom";
  selector.events.change();
  assert.equal(input.disabled, false);
  input.value = baseUrl;
  ui.ids.get("settings").open = true;
  ui.document.events.click({ target: input });
  assert.equal(ui.ids.get("settings").open, true);
  save.focus();
  save.events.click();
  save.events.click();
  await settle();
  assert.equal(developmentApi.savedBaseUrl, baseUrl);
  assert.equal(developmentApi.baseUrl, defaultBase);
  assert.equal(ui.calls.filter(call => call.path === "/api/development").length, 1);
  assert.equal(ui.ids.get("development-api-reload").hidden, false);
  assert.equal(ui.ids.get("development-api-notice").hidden, true);
  assert.equal(ui.ids.get("open-inbox").href, "https://github.com/notifications");
  assert.equal(ui.document.activeElement, save);
  selector.value = "github";
  selector.events.change();
  save.events.click();
  await settle();
  assert.equal(developmentApi.savedBaseUrl, defaultBase);
  assert.equal(ui.ids.get("development-api-reload").hidden, true);
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
  ui.window.events.pagehide();
});

test("API saves during background settings reads are queued exactly once", async t => {
  const developmentApi = { baseUrl: defaultBase, savedBaseUrl: defaultBase, requiresReload: false };
  let reads = 0;
  let finish;
  const ui = await renderer({ developmentApi, onSettings: input => {
    if (!input && ++reads === 3) return new Promise(resolve => { finish = resolve; });
  } });
  t.after(() => {
    finish?.();
    ui.window.events.pagehide();
  });
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  ui.ids.get("development-api").value = "custom";
  ui.ids.get("development-api").events.change();
  ui.ids.get("development-api-url").value = baseUrl;
  await ui.fireTimer();
  assert.equal(typeof finish, "function");
  const save = ui.ids.get("development-api-save");
  assert.equal(save.disabled, false);
  save.focus();
  save.events.click();
  save.events.click();
  assert.equal(save.disabled, true);
  assert.equal(developmentApi.savedBaseUrl, defaultBase);
  assert.equal(ui.calls.filter(call => call.path === "/api/development").length, 0);
  finish();
  await settle();
  const writes = ui.calls.filter(call => call.path === "/api/development");
  assert.deepEqual(writes.map(call => JSON.parse(call.options.body)), [{ baseUrl }]);
  assert.equal(developmentApi.savedBaseUrl, baseUrl);
  assert.equal(developmentApi.baseUrl, defaultBase);
  assert.equal(ui.ids.get("development-api-reload").hidden, false);
  assert.equal(ui.ids.get("settings-error").hidden, true);
  assert.equal(ui.document.activeElement, save);
});

test("custom active APIs show a warning and host-specific inbox link while drafts survive settings refresh", async () => {
  const developmentApi = { baseUrl, savedBaseUrl: baseUrl, requiresReload: false };
  const ui = await renderer({ developmentApi });
  assert.equal(ui.ids.get("development-api-notice").hidden, false);
  assert.match(ui.ids.get("development-api-notice").textContent, /may share production data/);
  assert.equal(ui.ids.get("open-inbox").href, "https://git.example.com/notifications");
  assert.equal(ui.ids.get("development-api-active").textContent, `Active API: ${baseUrl}`);
  const input = ui.ids.get("development-api-url");
  input.value = "https://other.example.com/api/v3";
  ui.ids.get("settings").open = true;
  ui.ids.get("settings").events.toggle();
  await settle();
  assert.equal(input.value, "https://other.example.com/api/v3");
  assert.equal(ui.ids.get("development-api").value, "custom");
  ui.window.events.pagehide();
});

test("failed API saves keep the draft, expose the error and never claim success", async () => {
  const developmentApi = { baseUrl: defaultBase, savedBaseUrl: defaultBase, requiresReload: false };
  const ui = await renderer({ developmentApi, onDevelopment: async () => { throw new Error("Use an HTTPS REST API base URL."); } });
  ui.ids.get("development-api").value = "custom";
  ui.ids.get("development-api").events.change();
  ui.ids.get("development-api-url").value = "http://git.example.com";
  ui.ids.get("development-api-save").events.click();
  await settle();
  assert.equal(ui.ids.get("settings-error").hidden, false);
  assert.match(ui.ids.get("settings-error").textContent, /HTTPS/);
  assert.equal(ui.ids.get("development-api-url").value, "http://git.example.com");
  assert.equal(ui.ids.get("development-api-reload").hidden, true);
  assert.equal(developmentApi.savedBaseUrl, defaultBase);
  ui.window.events.pagehide();
});
