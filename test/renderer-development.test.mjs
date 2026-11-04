import test from "node:test";
import assert from "node:assert/strict";
import { html, renderer, settle } from "./renderer-fixtures.mjs";

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
